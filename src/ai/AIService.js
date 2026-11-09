import { AIProvider, AIProviderError } from './AIProvider.js';
import { ConversationManager } from './ConversationManager.js';
import { logger } from '../utils/logger.js';

const VALID_ROLES = new Set(['system', 'user', 'assistant']);

/**
 * Normalizes a message list down to plain, provider-safe {role, content} pairs.
 * Defends against ever forwarding malformed entries (e.g. a corrupted history item,
 * or - accidentally - a Discord.js Message/embed/response object) to the AI provider:
 * only known roles and string content survive; anything else is dropped.
 */
export function sanitizeMessages(messages) {
  return (messages || [])
    .filter((message) => message && VALID_ROLES.has(message.role) && typeof message.content === 'string' && message.content.length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}

export class AIService {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.conversations = dependencies.conversations || new ConversationManager(config.maxContextMessages);
    this.provider = dependencies.provider || new AIProvider(config);
    this.pending = new Map();
  }

  getConversation(context) { return this.conversations.get(context); }

  enqueue(context, operation) {
    const key = this.conversations.key(context);
    const previous = this.pending.get(key) || Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => {}, () => {});
    this.pending.set(key, settled);
    void settled.then(() => {
      if (this.pending.get(key) === settled) this.pending.delete(key);
    });
    return result;
  }

  clearConversation(context) {
    return this.enqueue(context, () => {
      this.conversations.clear(context);
      logger.info('AI conversation reset', { guild: context.guildId || 'dm', channel: context.channelId, user: context.userId });
    });
  }

  resetConversation(context) { return this.clearConversation(context); }

  generateResponse(context, prompt, deliver = async () => {}) {
    return this.enqueue(context, async () => {
      const system = { role: 'system', content: this.config.systemPrompt };
      const current = { role: 'user', content: prompt };
      const history = this.conversations.get(context);
      const budget = this.config.maxContextBytes ?? 64000;
      const size = messages => messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0);
      if (size([system, current]) > budget) throw new AIProviderError('context_too_large');
      let dropped = 0;
      while (history.length && size([system, ...history, current]) > budget) {
        history.splice(0, 2);
        dropped += 2;
      }
      const messages = sanitizeMessages([system, ...history, current]);
      if (dropped) logger.info('AI context trimmed', { droppedMessages: dropped, contextBytes: size(messages), budgetBytes: budget });
      const response = await this.provider.generate(messages);
      if (typeof response !== 'string' || !response.trim()) throw new AIProviderError('empty_response');
      await deliver(response);
      this.conversations.add(context, current);
      this.conversations.add(context, { role: 'assistant', content: response });
      return response;
    });
  }
}

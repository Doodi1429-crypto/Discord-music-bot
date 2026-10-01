import { AIProvider } from './AIProvider.js';
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
  }

  getConversation(context) { return this.conversations.get(context); }

  clearConversation(context) {
    this.conversations.clear(context);
    logger.info('AI conversation reset', { guild: context.guildId || 'dm', channel: context.channelId, user: context.userId });
  }

  resetConversation(context) { this.clearConversation(context); }

  async generateResponse(context, prompt) {
    const messages = sanitizeMessages([
      { role: 'system', content: this.config.systemPrompt },
      ...this.conversations.get(context),
      { role: 'user', content: prompt }
    ]);
    // A failed request never touches stored history: the user/assistant pair below is
    // only persisted after the provider call succeeds, so one failure cannot corrupt
    // the conversation used by subsequent requests.
    const response = await this.provider.generate(messages);
    this.conversations.add(context, { role: 'user', content: prompt });
    if (response) this.conversations.add(context, { role: 'assistant', content: response });
    return response;
  }
}

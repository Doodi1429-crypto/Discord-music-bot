import { AIProvider } from './AIProvider.js';
import { ConversationManager } from './ConversationManager.js';
import { logger } from '../utils/logger.js';

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
    const messages = [
      { role: 'system', content: this.config.systemPrompt },
      ...this.conversations.get(context),
      { role: 'user', content: prompt }
    ];
    const response = await this.provider.generate(messages);
    this.conversations.add(context, { role: 'user', content: prompt });
    if (response) this.conversations.add(context, { role: 'assistant', content: response });
    return response;
  }
}

export class ConversationManager {
  constructor(maxMessages = 12) {
    this.maxMessages = maxMessages;
    this.conversations = new Map();
  }

  key({ guildId, channelId, userId }) {
    return `${guildId || 'dm'}:${channelId}:${userId}`;
  }

  get(context) {
    return [...(this.conversations.get(this.key(context)) || [])];
  }

  add(context, message) {
    const key = this.key(context);
    const messages = [...(this.conversations.get(key) || []), { role: message.role, content: message.content }];
    this.conversations.set(key, messages.slice(-this.maxMessages));
    return this.get(context);
  }

  clear(context) {
    this.conversations.delete(this.key(context));
  }
}

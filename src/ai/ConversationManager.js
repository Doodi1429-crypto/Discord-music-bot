export class ConversationManager {
  constructor(maxMessages = 12) {
    // Always round down to an even number so stored history only ever holds complete
    // user/assistant turns; an odd cap could otherwise force a turn to be split in
    // half when trimmed, producing a non-alternating role sequence for the provider.
    this.maxMessages = Math.max(0, Math.floor(maxMessages / 2) * 2);
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

    // Only trim once a message count is even (i.e. a user/assistant turn has just been
    // completed), and always remove a full turn (2 messages) at a time from the front.
    // This guarantees the stored history never starts mid-turn (e.g. with a dangling
    // assistant message and no preceding user message).
    if (messages.length % 2 === 0) {
      while (messages.length > this.maxMessages) messages.splice(0, 2);
    }

    this.conversations.set(key, messages);
    return this.get(context);
  }

  clear(context) {
    this.conversations.delete(this.key(context));
  }
}

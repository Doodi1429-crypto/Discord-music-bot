import { AIProviderError } from './AIProvider.js';

export const AI_USER_ERROR = 'صار خطأ وأنا أحاول أفكر 😭 جرّب مرة ثانية.';

export function parseAITrigger(content, { trigger, botId }) {
  const mention = new RegExp(`^<@!?${botId}>\\s*`, 'u');
  if (mention.test(content)) return content.replace(mention, '').trim();
  const matchedTrigger = [trigger, '!ai', '/ai']
    .filter((candidate, index, candidates) => candidates.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length)
    .find(candidate => content.startsWith(candidate));
  if (matchedTrigger) return content.slice(matchedTrigger.length).trim();
  return null;
}

export function splitResponse(text, maxLength = 2000) {
  if (!text) return [];
  const chunks = [];
  for (let index = 0; index < text.length;) {
    let end = Math.min(index + maxLength, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end -= 1;
    if (end === index) throw new RangeError('AI response chunk size is too small');
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks;
}

export async function handleAIMessage(message, { service, config, botId, logger = console }) {
  const prompt = parseAITrigger(message.content || '', { trigger: config.trigger, botId });
  if (prompt === null) return false;
  const context = { guildId: message.guildId, channelId: message.channelId, userId: message.author.id };
  let stage = 'processing';
  const metadata = { guild: context.guildId || 'dm', channel: context.channelId, user: context.userId, messageId: message.id };
  try {
    if (prompt.toLowerCase() === 'reset') {
      await service.resetConversation(context);
      stage = 'reset_reply';
      await message.reply('تم مسح محادثتك في هذه القناة ✅');
      return true;
    }
    if (!prompt) {
      stage = 'prompt_reply';
      await message.reply('اكتب سؤالك بعد أمر الذكاء الاصطناعي.');
      return true;
    }
    void Promise.resolve().then(() => message.channel.sendTyping()).catch(error => {
      logger.warn?.('AI typing indicator failed', { ...metadata, name: error?.name, code: error?.code });
    });
    stage = 'generation';
    await service.generateResponse(context, prompt, async response => {
      stage = 'delivery';
      for (const chunk of splitResponse(response, config.maxResponseLength)) await message.reply(chunk);
    });
  } catch (error) {
    logger.warn?.('AI Discord request failed', { ...metadata, stage, name: error?.name, code: error instanceof AIProviderError ? error.code : error?.code, status: error?.status });
    try {
      await message.reply(error?.code === 'context_too_large' ? 'السؤال أو إعدادات السياق طويلة جداً. جرّب سؤالاً أقصر.' : AI_USER_ERROR);
    } catch (replyError) {
      logger.error?.('AI error notification delivery failed', { ...metadata, name: replyError?.name, code: replyError?.code, status: replyError?.status });
    }
  }
  return true;
}

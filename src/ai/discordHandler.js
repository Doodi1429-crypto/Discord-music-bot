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
  for (let index = 0; index < text.length; index += maxLength) chunks.push(text.slice(index, index + maxLength));
  return chunks;
}

export async function handleAIMessage(message, { service, config, botId, logger = console }) {
  const prompt = parseAITrigger(message.content || '', { trigger: config.trigger, botId });
  if (prompt === null) return false;
  const context = { guildId: message.guildId, channelId: message.channelId, userId: message.author.id };
  if (prompt.toLowerCase() === 'reset') {
    service.resetConversation(context);
    await message.reply('تم مسح محادثتك في هذه القناة ✅');
    return true;
  }
  if (!prompt) return true;
  try {
    await message.channel.sendTyping();
    const response = await service.generateResponse(context, prompt);
    for (const chunk of splitResponse(response, config.maxResponseLength)) await message.reply(chunk);
  } catch (error) {
    logger.warn?.('AI Discord request failed', { code: error instanceof AIProviderError ? error.code : 'unknown' });
    await message.reply(AI_USER_ERROR).catch(() => {});
  }
  return true;
}

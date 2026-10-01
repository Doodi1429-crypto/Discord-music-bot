import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIProvider, AIProviderError } from '../src/ai/AIProvider.js';
import { ConversationManager } from '../src/ai/ConversationManager.js';
import { parseAITrigger, splitResponse, handleAIMessage } from '../src/ai/discordHandler.js';

const providerConfig = { apiKey: 'test-key', model: 'test-model', apiUrl: 'https://example.test', timeoutMs: 20 };

test('Gemini OpenAI-compatible provider sends the expected request and reads its response', async () => {
  let request;
  let requestUrl;
  const messages = [
    { role: 'system', content: 'system instructions' },
    { role: 'user', content: 'hi' }
  ];
  const provider = new AIProvider({
    ...providerConfig,
    provider: 'gemini',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.6-flash',
    fetchImpl: async (url, options) => {
      requestUrl = url;
      request = options;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hello' } }] }) };
    }
  });
  assert.equal(await provider.generate(messages), 'hello');
  assert.equal(requestUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer ' + providerConfig.apiKey);
  assert.deepEqual(JSON.parse(request.body), { model: 'gemini-3.6-flash', messages });
});

test('AI provider handles missing credentials, rate limits, malformed responses and failures', async () => {
  assert.throws(() => new AIProvider({ ...providerConfig, apiKey: '' }), /credentials/);
  for (const response of [
    { ok: false, status: 429, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({}) },
    { ok: false, status: 503, json: async () => ({}) }
  ]) {
    await assert.rejects(new AIProvider({ ...providerConfig, fetchImpl: async () => response }).generate([]), AIProviderError);
  }
});

test('AI provider maps aborts to timeout', async () => {
  await assert.rejects(
    new AIProvider({ ...providerConfig, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })));
    }) }).generate([]),
    error => error.code === 'timeout'
  );
});

test('conversation context trims and isolates keys', () => {
  const manager = new ConversationManager(2);
  const first = { guildId: 'g', channelId: 'c', userId: 'u' };
  const second = { guildId: 'g', channelId: 'c', userId: 'other' };
  manager.add(first, { role: 'user', content: 'one' });
  manager.add(first, { role: 'assistant', content: 'two' });
  manager.add(first, { role: 'user', content: 'three' });
  assert.deepEqual(manager.get(first).map(item => item.content), ['two', 'three']);
  assert.deepEqual(manager.get(second), []);
  manager.clear(first);
  assert.deepEqual(manager.get(first), []);
});

test('AI triggers only on mention or configured prefix and splits safely', () => {
  assert.equal(parseAITrigger('<@123> hello', { trigger: '!ask', botId: '123' }), 'hello');
  assert.equal(parseAITrigger('!ask hello', { trigger: '!ask', botId: '123' }), 'hello');
  assert.equal(parseAITrigger('!ai hello', { trigger: '!ask', botId: '123' }), 'hello');
  assert.equal(parseAITrigger('/ai hello', { trigger: '!ask', botId: '123' }), 'hello');
  assert.equal(parseAITrigger('hello', { trigger: '!ask', botId: '123' }), null);
  assert.deepEqual(splitResponse('abcdef', 2), ['ab', 'cd', 'ef']);
  assert.deepEqual(splitResponse('', 2), []);
});

test('Discord handler ignores empty AI responses and reports sanitized failures', async () => {
  const replies = [];
  const message = {
    content: '/ai hello', guildId: 'g', channelId: 'c', author: { id: 'u' },
    channel: { sendTyping: async () => {} }, reply: async value => replies.push(value)
  };
  await handleAIMessage(message, {
    service: { generateResponse: async () => '' },
    config: { trigger: '/ai', maxResponseLength: 2 }, botId: '123'
  });
  assert.deepEqual(replies, []);
  await handleAIMessage(message, {
    service: { generateResponse: async () => { throw new Error('secret provider detail'); } },
    config: { trigger: '/ai', maxResponseLength: 2 }, botId: '123', logger: { warn: () => {} }
  });
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /secret provider/);
});

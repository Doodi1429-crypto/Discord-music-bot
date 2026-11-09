import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AIProvider, AIProviderError, redactSecrets } from '../src/ai/AIProvider.js';
import { ConversationManager } from '../src/ai/ConversationManager.js';
import { AIService, sanitizeMessages } from '../src/ai/AIService.js';
import { parseAITrigger, splitResponse, handleAIMessage } from '../src/ai/discordHandler.js';

const providerConfig = { apiKey: 'test-key', model: 'test-model', apiUrl: 'https://example.test', timeoutMs: 20 };

function fakeContext() {
  return { guildId: 'g', channelId: 'c', userId: 'u' };
}

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
  // A 3rd message starts a new turn (odd length); trimming is deferred until the turn
  // completes so a user/assistant pair is never split in half.
  manager.add(first, { role: 'user', content: 'three' });
  assert.deepEqual(manager.get(first).map(item => item.content), ['one', 'two', 'three']);
  manager.add(first, { role: 'assistant', content: 'four' });
  assert.deepEqual(manager.get(first).map(item => item.content), ['three', 'four']);
  assert.deepEqual(manager.get(second), []);
  manager.clear(first);
  assert.deepEqual(manager.get(first), []);
});

test('conversation history never splits a user/assistant turn across many exchanges', () => {
  const manager = new ConversationManager(4);
  const ctx = { guildId: 'g', channelId: 'c', userId: 'u' };
  for (let turn = 1; turn <= 5; turn += 1) {
    manager.add(ctx, { role: 'user', content: `u${turn}` });
    manager.add(ctx, { role: 'assistant', content: `a${turn}` });
  }
  const history = manager.get(ctx);
  assert.deepEqual(history.map(item => item.content), ['u4', 'a4', 'u5', 'a5']);
  assert.equal(history[0].role, 'user');
  assert.equal(history.length % 2, 0);
});

test('odd maxMessages config is rounded down to the nearest even number', () => {
  const manager = new ConversationManager(5);
  assert.equal(manager.maxMessages, 4);
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

test('Discord handler reports empty AI responses and sanitized failures', async () => {
  const replies = [];
  const message = {
    content: '/ai hello', guildId: 'g', channelId: 'c', author: { id: 'u' },
    channel: { sendTyping: async () => {} }, reply: async value => replies.push(value)
  };
  await handleAIMessage(message, {
    service: new AIService({ systemPrompt: 'sys' }, { provider: { generate: async () => '' } }),
    config: { trigger: '/ai', maxResponseLength: 2 }, botId: '123'
  });
  assert.equal(replies.length, 1);
  await handleAIMessage(message, {
    service: { generateResponse: async () => { throw new Error('secret provider detail'); } },
    config: { trigger: '/ai', maxResponseLength: 2 }, botId: '123', logger: { warn: () => {} }
  });
  assert.equal(replies.length, 2);
  assert.doesNotMatch(replies[1], /secret provider/);
});

test('AIService handles 5 consecutive requests with valid, growing, alternating history', async () => {
  const sentMessages = [];
  const provider = {
    generate: async (messages) => {
      sentMessages.push(messages);
      // Every call must be a valid role sequence: system first, then alternating
      // user/assistant turns, ending with the current user prompt.
      assert.equal(messages[0].role, 'system');
      assert.equal(messages[messages.length - 1].role, 'user');
      for (const message of messages) {
        assert.ok(['system', 'user', 'assistant'].includes(message.role));
        assert.equal(typeof message.content, 'string');
      }
      return `reply-${sentMessages.length}`;
    }
  };
  const service = new AIService(
    { systemPrompt: 'sys', maxContextMessages: 12 },
    { provider, conversations: new ConversationManager(12) }
  );
  const ctx = fakeContext();
  for (let index = 1; index <= 5; index += 1) {
    const response = await service.generateResponse(ctx, `prompt-${index}`);
    assert.equal(response, `reply-${index}`);
  }
  assert.equal(sentMessages.length, 5);
  // Request 5 should see system + 4 prior turns (8 messages) + current prompt.
  assert.equal(sentMessages[4].length, 10);
  assert.deepEqual(service.getConversation(ctx).map(m => m.content).slice(-2), ['prompt-5', 'reply-5']);
});

test('AIService trims history to complete turns once maxContextMessages is exceeded', async () => {
  const provider = { generate: async () => 'ok' };
  const service = new AIService(
    { systemPrompt: 'sys', maxContextMessages: 4 },
    { provider, conversations: new ConversationManager(4) }
  );
  const ctx = fakeContext();
  for (let index = 1; index <= 5; index += 1) await service.generateResponse(ctx, `prompt-${index}`);
  const history = service.getConversation(ctx);
  assert.equal(history.length, 4);
  assert.equal(history[0].role, 'user');
  assert.deepEqual(history.map(m => m.content), ['prompt-4', 'ok', 'prompt-5', 'ok']);
});

test('sanitizeMessages drops invalid entries instead of forwarding them to the provider', () => {
  const fakeDiscordMessage = { content: 'hi', author: { id: '1' }, reply: () => {} };
  const sanitized = sanitizeMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'ok' },
    { role: 'weird', content: 'bad-role' },
    { role: 'assistant', content: 123 },
    fakeDiscordMessage,
    null,
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'good' }
  ]);
  assert.deepEqual(sanitized, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: 'good' }
  ]);
});

test('AIService recovers after a failed request without corrupting stored history', async () => {
  let callCount = 0;
  const provider = {
    generate: async () => {
      callCount += 1;
      if (callCount === 2) throw new AIProviderError('outage');
      return `reply-${callCount}`;
    }
  };
  const service = new AIService(
    { systemPrompt: 'sys', maxContextMessages: 12 },
    { provider, conversations: new ConversationManager(12) }
  );
  const ctx = fakeContext();
  assert.equal(await service.generateResponse(ctx, 'prompt-1'), 'reply-1');
  await assert.rejects(service.generateResponse(ctx, 'prompt-2'), AIProviderError);
  // The failed prompt-2 must not have been persisted.
  assert.deepEqual(service.getConversation(ctx).map(m => m.content), ['prompt-1', 'reply-1']);
  assert.equal(await service.generateResponse(ctx, 'prompt-3'), 'reply-3');
  assert.deepEqual(service.getConversation(ctx).map(m => m.content), ['prompt-1', 'reply-1', 'prompt-3', 'reply-3']);
});

test('AIProvider logs structured diagnostics without exposing credentials or conversation text', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const provider = new AIProvider({
      ...providerConfig,
      apiKey: 'super-secret-key',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'private conversation super-secret-key', code: 'RATE_LIMIT' } })
      })
    });
    await assert.rejects(provider.generate([]), AIProviderError);
  } finally {
    console.log = originalLog;
  }
  const combined = logs.join('\n');
  assert.match(combined, /AI request failed/);
  assert.match(combined, /RATE_LIMIT/);
  assert.doesNotMatch(combined, /super-secret-key/);
  assert.doesNotMatch(combined, /private conversation/);
});

test('redactSecrets strips Authorization headers, api keys, and configured secret values', () => {
  assert.equal(redactSecrets('Authorization: ******'), 'Authorization: [REDACTED]');
  assert.equal(redactSecrets('header ****** trailing'), 'header ****** trailing');
  assert.equal(redactSecrets('my key is my-secret-value', ['my-secret-value']), 'my key is [REDACTED]');
});

test('provider distinguishes auth, model, empty and incomplete responses', async () => {
  for (const [response, code] of [
    [{ ok: false, status: 401 }, 'authentication'],
    [{ ok: false, status: 403 }, 'authentication'],
    [{ ok: false, status: 404 }, 'model_or_endpoint_not_found'],
    [{ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'context_length_exceeded' } }) }, 'context_too_large'],
    [{ ok: true, json: async () => ({ choices: [{ message: { content: '  ' } }] }) }, 'empty_response'],
    [{ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }) }, 'incomplete_response']
  ]) {
    const provider = new AIProvider({ ...providerConfig, fetchImpl: async () => response });
    await assert.rejects(provider.generate([]), error => error.code === code);
  }
});

test('real HTTP request sends authentication and handles a compatible response', async () => {
  let observed;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    observed = { authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'local answer' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider = new AIProvider({ ...providerConfig, timeoutMs: 2000, apiUrl: `http://127.0.0.1:${server.address().port}/chat/completions` });
    assert.equal(await provider.generate([{ role: 'user', content: 'hello' }]), 'local answer');
    assert.equal(observed.authorization, 'Bearer test-key');
    assert.equal(observed.body.model, 'test-model');
    assert.deepEqual(observed.body.messages, [{ role: 'user', content: 'hello' }]);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('timeout covers response body processing as well as connecting', async () => {
  const provider = new AIProvider({
    ...providerConfig,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      json: () => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })));
      })
    })
  });
  await assert.rejects(provider.generate([]), error => error.code === 'timeout');
});

test('context byte budget drops only whole old turns and rejects an oversized current prompt', async () => {
  const requests = [];
  const service = new AIService({ systemPrompt: 's', maxContextMessages: 12, maxContextBytes: 15 }, {
    provider: { generate: async messages => { requests.push(messages); return 'abcd'; } }
  });
  const ctx = fakeContext();
  await service.generateResponse(ctx, '1234');
  await service.generateResponse(ctx, '5678');
  assert.deepEqual(requests[1].map(m => m.content), ['s', '1234', 'abcd', '5678']);
  await service.generateResponse(ctx, '9999');
  assert.deepEqual(requests[2].map(m => m.content), ['s', '5678', 'abcd', '9999']);
  await assert.rejects(service.generateResponse(ctx, 'é'.repeat(8)), error => error.code === 'context_too_large');
  assert.equal(requests.length, 3);
});

test('concurrent follow-ups and reset are ordered, and other conversations remain independent', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const requests = [];
  const service = new AIService({ systemPrompt: 'sys', maxContextMessages: 12 }, {
    provider: { generate: async messages => {
      requests.push(messages);
      if (messages.at(-1).content === 'first') await waiting;
      return `answer ${messages.at(-1).content}`;
    } }
  });
  const ctx = fakeContext();
  const first = service.generateResponse(ctx, 'first');
  const second = service.generateResponse(ctx, 'second');
  const reset = service.resetConversation(ctx);
  const third = service.generateResponse(ctx, 'third');
  await service.generateResponse({ ...ctx, userId: 'other' }, 'independent');
  assert.deepEqual(requests.map(m => m.at(-1).content), ['first', 'independent']);
  release();
  await Promise.all([first, second, reset, third]);
  const secondRequest = requests.find(m => m.at(-1).content === 'second');
  assert.deepEqual(secondRequest.map(m => m.content), ['sys', 'first', 'answer first', 'second']);
  const thirdRequest = requests.find(m => m.at(-1).content === 'third');
  assert.deepEqual(thirdRequest.map(m => m.content), ['sys', 'third']);
  assert.deepEqual(service.getConversation(ctx).map(m => m.content), ['third', 'answer third']);
  assert.equal(service.pending.size, 0);
});

test('short, long, complex and follow-up Discord prompts are delivered with ordered context', async () => {
  const requests = [];
  const service = new AIService({ systemPrompt: 'sys', maxContextMessages: 12 }, {
    provider: { generate: async messages => {
      requests.push(messages);
      return requests.length === 2 ? 'A'.repeat(1999) + '😀' + 'B'.repeat(50) : `answer ${requests.length}`;
    } }
  });
  const replies = [];
  const config = { trigger: '!ai', maxResponseLength: 2000 };
  const prompts = ['Hi?', 'Explain ' + 'x'.repeat(1900), 'Compare three approaches, justify tradeoffs and give an example.', 'What about the second approach?'];
  for (const prompt of prompts) {
    await handleAIMessage({
      content: `!ai ${prompt}`, guildId: 'g', channelId: 'c', author: { id: 'u' },
      channel: { sendTyping: async () => {} }, reply: async value => replies.push(value)
    }, { service, config, botId: '123' });
  }
  assert.equal(replies.length, 5);
  assert.equal(replies[1].length, 1999);
  assert.equal(replies[2], '😀' + 'B'.repeat(50));
  assert.deepEqual(requests[3].filter(m => m.role === 'user').map(m => m.content), prompts);
  assert.equal(service.getConversation(fakeContext()).length, 8);
});

test('typing failure does not block generation, while delivery failure is logged and history remains clean', async () => {
  const logs = [];
  const replies = [];
  let failDelivery = true;
  const service = new AIService({ systemPrompt: 'sys', maxContextMessages: 12 }, {
    provider: { generate: async () => 'answer' }
  });
  const message = {
    content: '!ai hello', guildId: 'g', channelId: 'c', author: { id: 'u' },
    channel: { sendTyping: async () => { throw Object.assign(new Error('typing denied'), { code: 50013 }); } },
    reply: async value => {
      if (value === 'answer' && failDelivery) throw Object.assign(new Error('send denied'), { code: 50013 });
      replies.push(value);
    }
  };
  const options = { service, config: { trigger: '!ai', maxResponseLength: 2000 }, botId: '123', logger: {
    warn: (message, meta) => logs.push({ message, meta }),
    error: (message, meta) => logs.push({ message, meta })
  } };
  await handleAIMessage(message, options);
  assert.equal(replies.length, 1);
  assert.deepEqual(service.getConversation(fakeContext()), []);
  assert.ok(logs.some(log => log.message === 'AI typing indicator failed' && log.meta.code === 50013));
  assert.ok(logs.some(log => log.meta.stage === 'delivery' && log.meta.code === 50013));
  failDelivery = false;
  await handleAIMessage(message, options);
  assert.equal(replies.at(-1), 'answer');
  assert.deepEqual(service.getConversation(fakeContext()).map(m => m.content), ['hello', 'answer']);
});

test('failure to send error notification is logged', async () => {
  const logs = [];
  await handleAIMessage({
    content: '!ai hello', guildId: 'g', channelId: 'c', author: { id: 'u' },
    channel: { sendTyping: async () => {} }, reply: async () => { throw Object.assign(new Error('forbidden'), { code: 50013 }); }
  }, {
    service: { generateResponse: async () => { throw new AIProviderError('unavailable'); } },
    config: { trigger: '!ai', maxResponseLength: 2000 }, botId: '123',
    logger: { warn: () => {}, error: (message, meta) => logs.push({ message, meta }) }
  });
  assert.equal(logs[0].message, 'AI error notification delivery failed');
  assert.equal(logs[0].meta.code, 50013);
});

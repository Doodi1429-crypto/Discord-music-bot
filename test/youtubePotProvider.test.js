import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  BGUTIL_PROVIDER_VERSION,
  DEFAULT_YT_DLP_POT_PROVIDER_URL,
  resolveYtDlpPotProviderConfig,
  startYtDlpPotProvider
} from '../src/resolvers/ytDlpPotProvider.js';

function fakeChild({ withStderr = false } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.killed = signal !== 'SIGKILL';
    child.exitCode = signal === 'SIGTERM' ? 0 : 137;
    child.emit('exit', child.exitCode, signal);
  };
  if (withStderr) child.stderr = new EventEmitter();
  return child;
}

test('provider config defaults to the loopback service and accepts a custom local port', () => {
  assert.deepEqual(resolveYtDlpPotProviderConfig({ env: {} }), {
    enabled: true,
    baseUrl: DEFAULT_YT_DLP_POT_PROVIDER_URL,
    host: '127.0.0.1',
    port: 4416
  });
  assert.deepEqual(resolveYtDlpPotProviderConfig({
    env: { YOUTUBE_DL_POT_PROVIDER_URL: 'http://localhost:4500' }
  }), {
    enabled: true,
    baseUrl: 'http://127.0.0.1:4500',
    host: '127.0.0.1',
    port: 4500
  });
  assert.equal(
    resolveYtDlpPotProviderConfig({
      env: {},
      providerUrl: 'bgutil+http://127.0.0.1:4500'
    }).baseUrl,
    'http://127.0.0.1:4500'
  );
});

test('provider config rejects non-local URLs and invalid enable/port settings', () => {
  for (const providerUrl of [
    'https://127.0.0.1:4416',
    'http://provider.example:4416',
    '******127.0.0.1:4416',
    'http://127.0.0.1:4416/path',
    'http://127.0.0.1:80'
  ]) {
    assert.throws(() => resolveYtDlpPotProviderConfig({
      env: { YOUTUBE_DL_POT_PROVIDER_URL: providerUrl }
    }), /local HTTP (?:URL|service)|port between/);
  }
  assert.throws(() => resolveYtDlpPotProviderConfig({
    env: { YOUTUBE_DL_POT_PROVIDER_ENABLED: 'sometimes' }
  }), /must be true or false/);
});

test('provider starts on loopback, waits for the pinned version, and stops cleanly', async () => {
  const child = fakeChild();
  let spawnRequest;
  let checkedUrl;
  const provider = await startYtDlpPotProvider({
    env: {},
    spawnImpl: (...args) => {
      spawnRequest = args;
      return child;
    },
    fetchImpl: async (url) => {
      checkedUrl = url;
      return new Response(JSON.stringify({ version: BGUTIL_PROVIDER_VERSION }), { status: 200 });
    },
    providerScriptPath: '/app/provider/server/build/main.js'
  });

  assert.equal(provider.started, true);
  assert.equal(checkedUrl, 'http://127.0.0.1:4416/ping');
  assert.equal(spawnRequest[0], process.execPath);
  assert.deepEqual(spawnRequest[1], [
    '/app/provider/server/build/main.js',
    '--host',
    '127.0.0.1',
    '--port',
    '4416'
  ]);
  assert.deepEqual(spawnRequest[2], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  await provider.stop();
  assert.deepEqual(child.killSignals, ['SIGTERM']);
});

test('provider disabled by configuration does not spawn a process', async () => {
  const result = await startYtDlpPotProvider({
    env: { YOUTUBE_DL_POT_PROVIDER_ENABLED: 'false' },
    spawnImpl: () => assert.fail('disabled provider should not spawn')
  });
  assert.equal(result.started, false);
});

test('provider startup reports sanitized process errors and stops a failed child', async () => {
  const child = fakeChild();
  const spawnFailure = new Error('spawn failed with private token-value');
  spawnFailure.code = 'ENOENT';
  const starting = startYtDlpPotProvider({
    env: {},
    spawnImpl: () => {
      process.nextTick(() => child.emit('error', spawnFailure));
      return child;
    },
    fetchImpl: async () => { throw new Error('unreachable'); },
    timeoutMs: 100,
    pollIntervalMs: 1
  });

  await assert.rejects(starting, (error) => {
    assert.match(error.message, /could not start \(ENOENT\)/);
    assert.doesNotMatch(error.message, /private token-value/);
    return true;
  });
  assert.ok(child.killSignals.includes('SIGTERM'));
});

test('provider startup rejects a mismatched server version', async () => {
  const child = fakeChild();
  await assert.rejects(startYtDlpPotProvider({
    env: {},
    spawnImpl: () => child,
    fetchImpl: async () => new Response(JSON.stringify({ version: '1.3.2' }), { status: 200 }),
    timeoutMs: 100
  }), /incompatible version/);
});

// Reproduces the exact Render failure mode: the provider process never exits and never
// becomes reachable on /ping within the deadline, previously surfacing only a generic
// "did not become ready" message with no indication of why. The child's own stderr
// (e.g. a bind failure logged by the provider itself) must now be captured and included.
test('provider startup timeout surfaces captured provider stderr for diagnosis', async () => {
  const child = fakeChild({ withStderr: true });
  const starting = startYtDlpPotProvider({
    env: {},
    spawnImpl: () => {
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from('Could not listen on 127.0.0.1:4416 (Caused by EADDRINUSE)\n'));
      });
      return child;
    },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    timeoutMs: 50,
    pollIntervalMs: 5
  });

  await assert.rejects(starting, (error) => {
    assert.match(error.message, /did not become ready within 50ms/);
    assert.match(error.message, /Provider stderr: Could not listen on 127\.0\.0\.1:4416 \(Caused by EADDRINUSE\)/);
    return true;
  });
  assert.ok(child.killSignals.includes('SIGTERM'));
});

test('provider startup reports captured stderr when the child exits before becoming ready', async () => {
  const child = fakeChild({ withStderr: true });
  const starting = startYtDlpPotProvider({
    env: {},
    spawnImpl: () => {
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from('TypeError: Cannot find module \'canvas\'\n'));
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    },
    fetchImpl: async () => { throw new Error('unreachable'); },
    timeoutMs: 200,
    pollIntervalMs: 5
  });

  await assert.rejects(starting, (error) => {
    assert.match(error.message, /exited before becoming ready/);
    assert.match(error.message, /Provider stderr: TypeError: Cannot find module 'canvas'/);
    return true;
  });
});

test('provider startup diagnostics strip control characters and cap captured stderr length', async () => {
  const child = fakeChild({ withStderr: true });
  const hugeChunk = `${'x'.repeat(2_500)}\u0007tail-marker`;
  const starting = startYtDlpPotProvider({
    env: {},
    spawnImpl: () => {
      process.nextTick(() => child.stderr.emit('data', Buffer.from(hugeChunk)));
      return child;
    },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    timeoutMs: 50,
    pollIntervalMs: 5
  });

  await assert.rejects(starting, (error) => {
    assert.ok(error.message.includes('tail-marker'));
    assert.ok(!error.message.includes('\u0007'));
    assert.ok(error.message.length < hugeChunk.length);
    return true;
  });
});

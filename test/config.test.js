import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { DEFAULT_LOGIN_TIMEOUT_MS } from '../src/startup.js';

const REQUIRED_ENV = {
  DISCORD_TOKEN: 'a-token',
  CLIENT_ID: '123456789012345678'
};

function withEnv(overrides, fn) {
  const keys = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'LOGIN_TIMEOUT_MS', 'AI_ENABLED', 'AI_API_KEY', 'AI_MODEL', 'AI_TRIGGER'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, REQUIRED_ENV, overrides);
    return fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('loadConfig defaults loginTimeoutMs when LOGIN_TIMEOUT_MS is unset', () => {
  withEnv({}, () => {
    assert.equal(loadConfig().loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS);
  });
});

test('loadConfig defaults loginTimeoutMs when LOGIN_TIMEOUT_MS is an empty string', () => {
  withEnv({ LOGIN_TIMEOUT_MS: '' }, () => {
    assert.equal(loadConfig().loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS);
  });
});

test('loadConfig defaults loginTimeoutMs when LOGIN_TIMEOUT_MS is not a positive number', () => {
  withEnv({ LOGIN_TIMEOUT_MS: '-5' }, () => {
    assert.equal(loadConfig().loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS);
  });
  withEnv({ LOGIN_TIMEOUT_MS: 'not-a-number' }, () => {
    assert.equal(loadConfig().loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS);
  });
});

test('loadConfig honors a valid LOGIN_TIMEOUT_MS override', () => {
  withEnv({ LOGIN_TIMEOUT_MS: '5000' }, () => {
    assert.equal(loadConfig().loginTimeoutMs, 5000);
  });
});

test('loadConfig defaults AI to disabled and applies overrides', () => {
  withEnv({ AI_MODEL: 'custom' }, () => {
    const config = loadConfig();
    assert.equal(config.ai.enabled, false);
    assert.equal(config.ai.model, 'custom');
    assert.equal(config.ai.trigger, '/ai');
  });
});

test('loadConfig honors a custom AI trigger', () => {
  withEnv({ AI_TRIGGER: '?ai' }, () => {
    assert.equal(loadConfig().ai.trigger, '?ai');
  });
});

test('loadConfig rejects enabled AI without credentials or invalid boolean', () => {
  withEnv({ AI_ENABLED: 'true' }, () => assert.throws(() => loadConfig(), /AI_API_KEY/));
  withEnv({ AI_ENABLED: 'maybe' }, () => assert.throws(() => loadConfig(), /AI_ENABLED/));
});

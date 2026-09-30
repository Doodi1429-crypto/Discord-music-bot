import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loginWithTimeout } from '../src/startup.js';

// Simulates the exact failure mode reported on WispByte: client.login()'s returned promise
// never resolves or rejects because the gateway handshake is silently dropped by the host's
// network/firewall. Without a timeout, this would hang the process forever with no output.
test('loginWithTimeout rejects with a diagnostic error when login never settles', async () => {
  const client = { login: () => new Promise(() => {}) };

  await assert.rejects(
    loginWithTimeout(client, 'token', { timeoutMs: 20 }),
    (error) => {
      assert.match(error.message, /Timed out after 20ms/);
      assert.match(error.message, /discord\.com/);
      return true;
    }
  );
});

test('loginWithTimeout resolves with the login result when login succeeds before the timeout', async () => {
  const client = { login: () => Promise.resolve('resolved-token') };

  const result = await loginWithTimeout(client, 'token', { timeoutMs: 1000 });
  assert.equal(result, 'resolved-token');
});

test('loginWithTimeout propagates a login rejection instead of waiting for the timeout', async () => {
  const client = { login: () => Promise.reject(new Error('invalid token')) };

  await assert.rejects(
    loginWithTimeout(client, 'token', { timeoutMs: 1000 }),
    /invalid token/
  );
});

test('loginWithTimeout ignores a late login settlement after the timeout already fired', async () => {
  const emitter = new EventEmitter();
  const client = {
    login: () => new Promise((resolve) => {
      emitter.once('resolve-login', () => resolve('too-late'));
    })
  };

  await assert.rejects(loginWithTimeout(client, 'token', { timeoutMs: 10 }));

  // Resolving after the timeout already rejected must not throw an unhandled error.
  emitter.emit('resolve-login');
});

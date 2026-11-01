import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublicUrl, isPrivateAddress, isSoundCloudUrl, extractPlaylistId } from '../src/resolvers/urlUtils.js';
import { RateLimiter } from '../src/utils/rateLimiter.js';
import { acquireProcessLock } from '../src/utils/processLock.js';
import { arabicError, UserInputError, AudioSourceError } from '../src/utils/errors.js';

test('isPrivateAddress flags loopback, RFC1918, link-local, CGNAT, metadata and IPv6 private ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('assertPublicUrl blocks private IP literals, localhost, credentials and private DNS results', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  const privateLookup = async () => [{ address: '10.0.0.5' }];
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/a'));
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data'));
  await assert.rejects(() => assertPublicUrl('http://[::1]/a'));
  await assert.rejects(() => assertPublicUrl('http://localhost:3000/a'));
  await assert.rejects(() => assertPublicUrl('https://user:pw@example.com/a', { lookup: publicLookup }));
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'));
  await assert.rejects(() => assertPublicUrl('https://rebind.example/a', { lookup: privateLookup }));
  await assert.rejects(() => assertPublicUrl('https://x.example/a', { lookup: async () => { throw new Error('ENOTFOUND'); } }));
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/a', { ErrorType: UserInputError }), UserInputError);
  assert.equal((await assertPublicUrl('https://example.com/a.mp3', { lookup: publicLookup })).hostname, 'example.com');
});

test('URL helpers recognise SoundCloud and explicit YouTube playlists', () => {
  assert.equal(isSoundCloudUrl('https://soundcloud.com/a/b'), true);
  assert.equal(isSoundCloudUrl('https://evilsoundcloud.com/a'), false);
  assert.equal(extractPlaylistId('https://www.youtube.com/playlist?list=PLabcdefghijklmnop'), 'PLabcdefghijklmnop');
  assert.equal(extractPlaylistId('https://www.youtube.com/watch?v=abcdefghijk&list=PLabcdefghijklmnop'), null);
});

test('RateLimiter allows `limit` hits per window then reports the wait', () => {
  let t = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(limiter.check('u'), 0);
  assert.equal(limiter.check('u'), 0);
  assert.ok(limiter.check('u') > 0);
  assert.equal(limiter.check('other'), 0);
  t = 1001;
  assert.equal(limiter.check('u'), 0);
});

test('process lock refuses a live duplicate and replaces a stale lock', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lock-')), 'bot.lock');
  const release = acquireProcessLock({ path, pid: 111, alive: () => true });
  assert.throws(() => acquireProcessLock({ path, pid: 222, alive: () => true }), /already running/);
  release();
  const stale = acquireProcessLock({ path, pid: 333, alive: () => true });
  const replaced = acquireProcessLock({ path, pid: 444, alive: () => false });
  replaced(); stale();
});

test('arabicError never leaks internals and explains YouTube bot checks', () => {
  assert.match(arabicError(new Error('secret stack /root/x')), /فشل التشغيل/);
  assert.doesNotMatch(arabicError(new Error('secret stack /root/x')), /secret/);
  assert.match(arabicError(new AudioSourceError("Sign in to confirm you're not a bot")), /SoundCloud/);
  assert.equal(arabicError(new UserInputError('رسالة')), 'رسالة');
});

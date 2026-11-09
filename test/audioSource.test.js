import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioSource, resolveFfmpegPath, describeStreamUrl, redactUrls } from '../src/music/AudioSource.js';
import { AudioSourceError } from '../src/utils/errors.js';

test('resolveFfmpegPath prefers an explicit FFMPEG_PATH override', () => {
  assert.equal(resolveFfmpegPath('/usr/bin/ffmpeg', { staticPath: '/opt/ffmpeg-static/ffmpeg', exists: () => true }), '/usr/bin/ffmpeg');
});

test('resolveFfmpegPath uses the ffmpeg-static binary when it was actually downloaded', () => {
  assert.equal(resolveFfmpegPath(undefined, { staticPath: '/opt/ffmpeg-static/ffmpeg', exists: () => true }), '/opt/ffmpeg-static/ffmpeg');
});

test('resolveFfmpegPath falls back to a system ffmpeg when the ffmpeg-static binary is missing', () => {
  // Simulates a host (e.g. a restricted Node.js hosting provider) that blocked ffmpeg-static's
  // postinstall download, so the package resolves but the binary file was never created.
  assert.equal(resolveFfmpegPath(undefined, { staticPath: '/opt/ffmpeg-static/ffmpeg', exists: () => false }), 'ffmpeg');
});

test('resolveFfmpegPath falls back to a system ffmpeg when ffmpeg-static is unresolved', () => {
  assert.equal(resolveFfmpegPath(undefined, { staticPath: null, exists: () => false }), 'ffmpeg');
});

test('AudioSource.create rejects non-http(s) and local URLs before spawning ffmpeg', async () => {
  const source = new AudioSource({ ffmpegPath: 'ffmpeg' });
  await assert.rejects(() => source.create({ url: 'not a url' }), AudioSourceError);
  await assert.rejects(() => source.create({ url: 'file:///etc/passwd' }), AudioSourceError);
  await assert.rejects(() => source.create({ url: 'http://localhost/audio.mp3' }), AudioSourceError);
});

test('AudioSource.create surfaces a clear error when the ffmpeg binary cannot be found', async () => {
  const source = new AudioSource({ ffmpegPath: '/definitely/not/a/real/ffmpeg-binary', assertUrl: async (u) => new URL(u) });
  await assert.rejects(
    () => source.create({ url: 'https://example.com/audio.mp3' }),
    (error) => {
      assert.ok(error instanceof AudioSourceError);
      assert.match(error.message, /FFmpeg executable not found/);
      return true;
    }
  );
});

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  const originalError = console.error;
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  try { await fn(); } finally { console.log = original; console.error = originalError; }
  return lines;
}

test('describeStreamUrl exposes only host, scheme and extension, never signed paths or queries', () => {
  const info = describeStreamUrl(new URL('https://cf-media.sndcdn.com/secret-path/track.mp3?Policy=SIGNED&Signature=abc'), { protocol: 'http', ext: 'mp3', acodec: 'mp3' });
  assert.equal(info.host, 'cf-media.sndcdn.com');
  assert.equal(info.urlExtension, 'mp3');
  assert.equal(info.protocol, 'http');
  assert.doesNotMatch(JSON.stringify(info), /SIGNED|Signature|secret-path/);
});

async function runFakeFfmpeg(script, wait) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-ffmpeg-'));
  const path = join(dir, 'ffmpeg');
  await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const source = new AudioSource({ ffmpegPath: path, flowCheckDelaysMs: [200], assertUrl: async (value) => new URL(value) });
  let resource;
  const lines = await captureLogs(async () => {
    resource = await source.create({ title: 'T', source: 'soundcloud', url: 'https://cdn.example/a.m3u8?sig=TOPSECRET', streamInfo: { protocol: 'm3u8_native' } });
    resource.playStream.resume();
    await new Promise((resolve) => setTimeout(resolve, wait));
    resource.cleanup();
  });
  await rm(dir, { recursive: true, force: true });
  return lines.join('\n');
}

test('AudioSource logs the selected stream without the signed URL and reports flowing audio', async () => {
  const logs = await runFakeFfmpeg('head -c 4096 /dev/zero; sleep 2', 500);
  assert.match(logs, /Audio stream selected.*"host":"cdn.example".*"protocol":"m3u8_native"/);
  assert.match(logs, /FFmpeg audio flowing.*"bytesOut":[1-9]/);
  assert.doesNotMatch(logs, /TOPSECRET/);
});

test('AudioSource warns when ffmpeg produces no audio data', async () => {
  const logs = await runFakeFfmpeg('sleep 2', 500);
  assert.match(logs, /\[WARN\] FFmpeg produced no audio data.*"bytesOut":0/);
});

test('redactUrls strips signed paths and queries from FFmpeg error text', () => {
  const text = redactUrls("[http @ 0x1] HTTP error 403 Forbidden for https://cf-media.sndcdn.com/a/b.mp3?Policy=SIGNED&Signature=abc: failed");
  assert.match(text, /https:\/\/cf-media\.sndcdn\.com\/\[REDACTED\] failed/);
  assert.doesNotMatch(text, /SIGNED|Signature|b\.mp3/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioSource, resolveFfmpegPath } from '../src/music/AudioSource.js';
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
  const source = new AudioSource({ ffmpegPath: '/definitely/not/a/real/ffmpeg-binary' });
  await assert.rejects(
    () => source.create({ url: 'https://example.com/audio.mp3' }),
    (error) => {
      assert.ok(error instanceof AudioSourceError);
      assert.match(error.message, /FFmpeg executable not found/);
      return true;
    }
  );
});

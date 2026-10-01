import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenericResolver } from '../src/resolvers/GenericResolver.js';
import { AudioSourceError } from '../src/utils/errors.js';

/** Builds a fake yt-dlp runner, so no real binary/network access is needed in tests. */
function fakeRunner(result) {
  const calls = [];
  return {
    calls,
    run: async (binaryPath, args, options) => {
      calls.push({ binaryPath, args, options });
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

test('GenericResolver extracts playable audio from a SoundCloud-style yt-dlp result', async () => {
  const { run, calls } = fakeRunner({
    title: 'A SoundCloud track',
    duration: 180,
    formats: [{ acodec: 'opus', url: 'https://cf-media.sndcdn.com/track.opus' }]
  });
  const resolver = new GenericResolver({ ytDlpBinaryPath: '/usr/bin/yt-dlp', ytDlpRunner: run });
  const track = await resolver.resolve('https://soundcloud.com/artist/track');
  assert.equal(track.url, 'https://cf-media.sndcdn.com/track.opus');
  assert.equal(track.title, 'A SoundCloud track');
  assert.equal(track.duration, 180);
  assert.equal(track.source, 'generic');
  // Must not pass any YouTube-specific PO-token/bgutil/player-client flags.
  const argString = calls[0].args.join(' ');
  assert.doesNotMatch(argString, /player[-_]client|po[-_]token|pot[-_]provider|plugin-dirs/i);
  assert.deepEqual(calls[0].args, [
    '--dump-single-json', '--no-warnings', '--no-playlist', '--format', 'bestaudio/best',
    'https://soundcloud.com/artist/track'
  ]);
});

test('GenericResolver extracts playable audio from a Bandcamp-style yt-dlp result using requested_downloads', async () => {
  const { run } = fakeRunner({
    title: 'A Bandcamp album track',
    duration: 240,
    requested_downloads: [{ url: 'https://t4.bcbits.com/stream/track.mp3' }]
  });
  const resolver = new GenericResolver({ ytDlpBinaryPath: '/usr/bin/yt-dlp', ytDlpRunner: run });
  const track = await resolver.resolve('https://artist.bandcamp.com/track/song');
  assert.equal(track.url, 'https://t4.bcbits.com/stream/track.mp3');
  assert.equal(track.source, 'generic');
});

test('GenericResolver extracts playable audio from a Vimeo-style yt-dlp result using direct acodec/url', async () => {
  const { run } = fakeRunner({
    title: 'A Vimeo video',
    duration: 90,
    acodec: 'aac',
    url: 'https://vod-progressive.akamaized.net/video.mp4'
  });
  const resolver = new GenericResolver({ ytDlpBinaryPath: '/usr/bin/yt-dlp', ytDlpRunner: run });
  const track = await resolver.resolve('https://vimeo.com/123456789');
  assert.equal(track.url, 'https://vod-progressive.akamaized.net/video.mp4');
});

test('GenericResolver returns a clean user-facing error when yt-dlp yields no playable audio', async () => {
  const { run } = fakeRunner({ title: 'No audio here', formats: [{ acodec: 'none', url: 'https://example.com/video' }] });
  const resolver = new GenericResolver({ ytDlpBinaryPath: '/usr/bin/yt-dlp', ytDlpRunner: run });
  await assert.rejects(
    resolver.resolve('https://example.com/some-page'),
    (error) => error instanceof AudioSourceError && /playable audio/.test(error.message)
  );
});

test('GenericResolver returns a clean error (not a silent fake playback) when yt-dlp itself fails', async () => {
  const { run } = fakeRunner(Object.assign(new Error('ERROR: Unsupported URL'), { stderr: 'ERROR: Unsupported URL' }));
  const resolver = new GenericResolver({ ytDlpBinaryPath: '/usr/bin/yt-dlp', ytDlpRunner: run });
  await assert.rejects(
    resolver.resolve('https://example.com/not-a-media-site'),
    (error) => error instanceof AudioSourceError && /Failed to extract playable audio/.test(error.message)
  );
});

test('GenericResolver returns a clean error when no yt-dlp binary is configured, instead of pretending the URL is playable', async () => {
  const resolver = new GenericResolver({ resolveYtDlpBinary: () => null });
  await assert.rejects(
    resolver.resolve('https://example.com/some-page'),
    (error) => error instanceof AudioSourceError && /yt-dlp/.test(error.message)
  );
});

test('GenericResolver never references YOUTUBE_DL_PO_TOKEN/PLAYER_CLIENT/POT_PROVIDER env configuration', async () => {
  const originalEnv = { ...process.env };
  process.env.YOUTUBE_DL_PO_TOKEN = 'secret-po-token';
  process.env.YOUTUBE_DL_PLAYER_CLIENT = 'mweb';
  process.env.YOUTUBE_DL_POT_PROVIDER_URL = 'http://127.0.0.1:4416';
  try {
    const { run, calls } = fakeRunner({ title: 'x', formats: [{ acodec: 'opus', url: 'https://example.com/a.opus' }] });
    const resolver = new GenericResolver({ ytDlpBinaryPath: '/usr/bin/yt-dlp', ytDlpRunner: run });
    await resolver.resolve('https://example.com/song');
    const argString = calls[0].args.join(' ');
    assert.doesNotMatch(argString, /secret-po-token|mweb|4416/);
  } finally {
    process.env = originalEnv;
  }
});

void UserInputError;

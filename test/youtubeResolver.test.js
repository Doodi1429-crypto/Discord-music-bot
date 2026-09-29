import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeResolver, resolveYtDlpPath } from '../src/resolvers/YouTubeResolver.js';
import { AudioSourceError } from '../src/utils/errors.js';

test('resolveYtDlpPath prefers YOUTUBE_DL_PATH over PATH discovery', () => {
  assert.equal(
    resolveYtDlpPath('/configured/yt-dlp', { pathValue: '/system/bin', access: () => true }),
    '/configured/yt-dlp'
  );
});

test('resolveYtDlpPath discovers yt-dlp before youtube-dl from PATH', () => {
  const checked = [];
  const path = resolveYtDlpPath(undefined, {
    pathValue: '/first/bin:/second/bin',
    access: (candidate) => {
      checked.push(candidate);
      return candidate === '/second/bin/yt-dlp';
    }
  });

  assert.equal(path, '/second/bin/yt-dlp');
  assert.deepEqual(checked, ['/first/bin/yt-dlp', '/first/bin/youtube-dl', '/second/bin/yt-dlp']);
});

test('resolveYtDlpPath returns null when no supported executable is available', () => {
  assert.equal(resolveYtDlpPath(undefined, { pathValue: '/empty', access: () => false }), null);
});

test('resolveVideoUrl invokes yt-dlp and returns its audio metadata', async () => {
  let invocation;
  const resolver = new YouTubeResolver({
    binaryPath: '/configured/yt-dlp',
    timeout: 5000,
    runner: async (...args) => {
      invocation = args;
      return {
        title: 'A video',
        duration: 42,
        url: 'https://media.example/audio',
        acodec: 'opus'
      };
    }
  });

  const result = await resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');

  assert.deepEqual(result, {
    url: 'https://media.example/audio',
    title: 'A video',
    duration: 42,
    source: 'youtube'
  });
  assert.deepEqual(invocation, [
    '/configured/yt-dlp',
    ['--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist', 'https://youtube.com/watch?v=abcdefghijk'],
    { timeout: 5000 }
  ]);
});

test('search keeps yt-dlp search output and resolves the first result', async () => {
  const invocations = [];
  const resolver = new YouTubeResolver({
    binaryPath: '/configured/yt-dlp',
    runner: async (binary, args) => {
      invocations.push(args);
      if (args.at(-1) === 'ytsearch1:some song') {
        return { entries: [{ id: 'abcdefghijk' }] };
      }
      return { title: 'Some song', url: 'https://media.example/audio', acodec: 'opus' };
    }
  });

  const result = await resolver.search('some song');

  assert.equal(result.title, 'Some song');
  assert.deepEqual(invocations, [
    ['--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', 'ytsearch1:some song'],
    ['--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist', 'https://www.youtube.com/watch?v=abcdefghijk']
  ]);
});

test('YOUTUBE_DL_PATH is used by default and yt-dlp failures retain actionable details', async () => {
  const previousPath = process.env.YOUTUBE_DL_PATH;
  process.env.YOUTUBE_DL_PATH = '/configured/yt-dlp';

  try {
    const resolver = new YouTubeResolver({
      runner: async (binaryPath) => {
        assert.equal(binaryPath, '/configured/yt-dlp');
        throw Object.assign(new Error('Command failed'), { stderr: 'ERROR: Sign in to confirm you’re not a bot' });
      }
    });

    await assert.rejects(
      resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
      (error) => {
        assert.ok(error instanceof AudioSourceError);
        assert.match(error.message, /Sign in to confirm you’re not a bot/);
        return true;
      }
    );
  } finally {
    if (previousPath === undefined) delete process.env.YOUTUBE_DL_PATH;
    else process.env.YOUTUBE_DL_PATH = previousPath;
  }
});

test('resolution reports how to configure the binary when none is installed', async () => {
  const previousPath = process.env.PATH;
  const previousBinaryPath = process.env.YOUTUBE_DL_PATH;
  process.env.PATH = '';
  delete process.env.YOUTUBE_DL_PATH;
  const resolver = new YouTubeResolver({
    binaryPath: '',
    runner: async () => assert.fail('runner should not be called')
  });
  try {
    await assert.rejects(
      resolver.getInfo('https://youtube.com/watch?v=abcdefghijk'),
      /Install yt-dlp or set YOUTUBE_DL_PATH/
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousBinaryPath === undefined) delete process.env.YOUTUBE_DL_PATH;
    else process.env.YOUTUBE_DL_PATH = previousBinaryPath;
  }
});

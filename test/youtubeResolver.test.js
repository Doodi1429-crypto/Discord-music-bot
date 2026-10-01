import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  YouTubeResolver,
  resolveYtDlpPath,
  resolveYtDlpConfigPath,
  resolveYtDlpCookiesPath
} from '../src/resolvers/YouTubeResolver.js';
import { UserInputError, AudioSourceError } from '../src/utils/errors.js';

/** Builds a fake youtubei.js-like client for tests, so no real network/YouTube access is needed. */
function fakeClient({
  info = () => ({
    playability_status: { status: 'OK' },
    basic_info: { title: 'A video', duration: 42 },
    chooseFormat: () => ({ decipher: async () => 'https://media.example/audio' })
  }),
  search = async () => ({ videos: [] })
} = {}) {
  return {
    session: { player: { id: 'fake-player' } },
    getBasicInfo: async (videoId) => info(videoId),
    search
  };
}

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

test('resolveVideoUrl resolves audio metadata entirely via the built-in (youtubei.js) client', async () => {
  let requestedVideoId;
  const resolver = new YouTubeResolver({
    createClient: async () => fakeClient({
      info: (videoId) => {
        requestedVideoId = videoId;
        return {
          playability_status: { status: 'OK' },
          basic_info: { title: 'A video', duration: 42 },
          chooseFormat: () => ({ decipher: async (player) => {
            assert.deepEqual(player, { id: 'fake-player' });
            return 'https://media.example/audio';
          } })
        };
      }
    })
  });

  const result = await resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');

  assert.equal(requestedVideoId, 'abcdefghijk');
  assert.deepEqual(result, {
    url: 'https://media.example/audio',
    title: 'A video',
    duration: 42,
    source: 'youtube'
  });
});

test('resolveVideoId rejects malformed video IDs without contacting any client', async () => {
  const resolver = new YouTubeResolver({
    createClient: async () => assert.fail('client should not be created for invalid input')
  });

  await assert.rejects(resolver.resolveVideoId('not-an-id'), UserInputError);
});

test('resolveVideoUrl surfaces unavailable/private videos as a user input error', async () => {
  const resolver = new YouTubeResolver({
    createClient: async () => fakeClient({
      info: () => ({
        playability_status: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' },
        basic_info: {},
        chooseFormat: () => { throw new Error('should not be reached'); }
      })
    })
  });

  await assert.rejects(
    resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
    (error) => {
      assert.ok(error instanceof UserInputError);
      assert.match(error.message, /unavailable/i);
      return true;
    }
  );
});

test('resolveVideoUrl reports a clear error when no audio format is available', async () => {
  const resolver = new YouTubeResolver({
    createClient: async () => fakeClient({
      info: () => ({
        playability_status: { status: 'OK' },
        basic_info: { title: 'A video' },
        chooseFormat: () => null
      })
    })
  });

  await assert.rejects(
    resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
    (error) => {
      assert.ok(error instanceof AudioSourceError);
      assert.match(error.message, /Could not extract a playable audio stream/);
      return true;
    }
  );
});

test('search resolves the first video result via the built-in client', async () => {
  let searchQuery;
  const resolver = new YouTubeResolver({
    createClient: async () => fakeClient({
      search: async (query) => {
        searchQuery = query;
        return { videos: [{ video_id: 'abcdefghijk' }] };
      },
      info: (videoId) => ({
        playability_status: { status: 'OK' },
        basic_info: { title: 'Some song', duration: 200 },
        chooseFormat: () => ({ decipher: async () => `https://media.example/${videoId}` })
      })
    })
  });

  const result = await resolver.search('some song');

  assert.equal(searchQuery, 'some song');
  assert.deepEqual(result, {
    url: 'https://media.example/abcdefghijk',
    title: 'Some song',
    duration: 200,
    source: 'youtube'
  });
});

test('search rejects short or missing queries without contacting any client', async () => {
  const resolver = new YouTubeResolver({
    createClient: async () => assert.fail('client should not be created for invalid input')
  });

  await assert.rejects(resolver.search(''), UserInputError);
  await assert.rejects(resolver.search('a'), UserInputError);
  await assert.rejects(resolver.search('x'.repeat(201)), UserInputError);
});

test('search reports no results as a user input error', async () => {
  const resolver = new YouTubeResolver({
    createClient: async () => fakeClient({ search: async () => ({ videos: [] }) })
  });

  await assert.rejects(
    resolver.search('an extremely obscure query'),
    (error) => {
      assert.ok(error instanceof UserInputError);
      assert.match(error.message, /No YouTube results found/);
      return true;
    }
  );
});

test('client initialization failures surface as an actionable AudioSourceError when no yt-dlp fallback is configured', async () => {
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '',
    createClient: async () => { throw new Error('network unavailable'); }
  });

  await assert.rejects(
    resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
    (error) => {
      assert.ok(error instanceof AudioSourceError);
      assert.match(error.message, /Failed to initialize the YouTube client/);
      return true;
    }
  );
});

test('falls back to an explicitly configured yt-dlp binary only after built-in resolution fails', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  const result = await resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');

  assert.deepEqual(result, {
    url: 'https://media.example/fallback',
    title: 'Fallback video',
    duration: 10,
    source: 'youtube'
  });
  assert.deepEqual(ytDlpInvocation, [
    '/configured/yt-dlp',
    ['--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist', 'https://youtube.com/watch?v=abcdefghijk'],
    { timeout: 30_000 }
  ]);
});

test('search falls back to yt-dlp only after built-in search fails', async () => {
  const invocations = [];
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    createClient: async () => fakeClient({
      search: async () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (binary, args) => {
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

test('resolveYtDlpConfigPath and resolveYtDlpCookiesPath trim values and default to null when unset', () => {
  assert.equal(resolveYtDlpConfigPath(''), null);
  assert.equal(resolveYtDlpConfigPath('  /etc/yt-dlp/config.conf  '), '/etc/yt-dlp/config.conf');
  assert.equal(resolveYtDlpCookiesPath(undefined), null);
  assert.equal(resolveYtDlpCookiesPath(' /secrets/cookies.txt '), '/secrets/cookies.txt');
});

test('yt-dlp fallback resolution passes configured config/cookies paths as discrete argv entries', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpConfigPath: '/etc/yt-dlp/config.conf',
    ytDlpCookiesPath: '/secrets/cookies.txt',
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');

  assert.deepEqual(ytDlpInvocation, [
    '/configured/yt-dlp',
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
      '--config-location', '/etc/yt-dlp/config.conf',
      '--cookies', '/secrets/cookies.txt',
      'https://youtube.com/watch?v=abcdefghijk'
    ],
    { timeout: 30_000 }
  ]);
});

test('yt-dlp search fallback passes configured config/cookies paths as discrete argv entries', async () => {
  const invocations = [];
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpConfigPath: '/etc/yt-dlp/config.conf',
    ytDlpCookiesPath: '/secrets/cookies.txt',
    createClient: async () => fakeClient({
      search: async () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (binary, args) => {
      invocations.push(args);
      if (args.includes('ytsearch1:some song')) {
        return { entries: [{ id: 'abcdefghijk' }] };
      }
      return { title: 'Some song', url: 'https://media.example/audio', acodec: 'opus' };
    }
  });

  await resolver.search('some song');

  assert.deepEqual(invocations, [
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best',
      '--config-location', '/etc/yt-dlp/config.conf',
      '--cookies', '/secrets/cookies.txt',
      'ytsearch1:some song'
    ],
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
      '--config-location', '/etc/yt-dlp/config.conf',
      '--cookies', '/secrets/cookies.txt',
      'https://www.youtube.com/watch?v=abcdefghijk'
    ]
  ]);
});

test('does not fall back to yt-dlp when the built-in client reports a user input error', async () => {
  let ytDlpCalled = false;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    createClient: async () => fakeClient({
      info: () => ({
        playability_status: { status: 'ERROR', reason: 'Video unavailable' },
        basic_info: {},
        chooseFormat: () => null
      })
    }),
    ytDlpRunner: async () => { ytDlpCalled = true; }
  });

  await assert.rejects(
    resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
    UserInputError
  );
  assert.equal(ytDlpCalled, false);
});

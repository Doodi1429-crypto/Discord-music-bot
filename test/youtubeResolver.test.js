import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  YouTubeResolver,
  resolveYtDlpPath,
  resolveYtDlpConfigPath,
  resolveYtDlpCookiesPath,
  resolveYtDlpJsRuntimes,
  resolveYtDlpPlayerClient,
  resolveYtDlpPoToken,
  resolveYtDlpPotProviderUrl,
  resolveYtDlpExtractorArgs,
  sanitizeDetails,
  errorDetails,
  DEFAULT_YT_DLP_JS_RUNTIMES,
  DEFAULT_YT_DLP_PLAYER_CLIENT
} from '../src/resolvers/YouTubeResolver.js';
import { YT_DLP_DEFAULT_PATH } from '../src/resolvers/ytDlpPaths.js';
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

test('resolveYtDlpPath prefers the default auto-installed path over PATH discovery', () => {
  const checked = [];
  const path = resolveYtDlpPath(undefined, {
    pathValue: '/system/bin',
    access: (candidate) => {
      checked.push(candidate);
      return candidate === YT_DLP_DEFAULT_PATH;
    }
  });

  assert.equal(path, YT_DLP_DEFAULT_PATH);
  assert.deepEqual(checked, [YT_DLP_DEFAULT_PATH]);
});

test('resolveYtDlpPath discovers yt-dlp before youtube-dl from PATH when no default-install binary is present', () => {
  const checked = [];
  const path = resolveYtDlpPath(undefined, {
    pathValue: '/first/bin:/second/bin',
    defaultInstallPath: null,
    access: (candidate) => {
      checked.push(candidate);
      return candidate === '/second/bin/yt-dlp';
    }
  });

  assert.equal(path, '/second/bin/yt-dlp');
  assert.deepEqual(checked, ['/first/bin/yt-dlp', '/first/bin/youtube-dl', '/second/bin/yt-dlp']);
});

test('resolveYtDlpPath returns null when no supported executable is available', () => {
  assert.equal(
    resolveYtDlpPath(undefined, { pathValue: '/empty', defaultInstallPath: null, access: () => false }),
    null
  );
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
    resolveYtDlpBinary: () => null,
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
    resolveYtDlpBinary: () => null,
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
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=mweb,default',
      'https://youtube.com/watch?v=abcdefghijk'
    ],
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
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=mweb,default',
      'ytsearch1:some song'
    ],
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=mweb,default',
      'https://www.youtube.com/watch?v=abcdefghijk'
    ]
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
      '--js-runtimes', 'node',
      '--config-location', '/etc/yt-dlp/config.conf',
      '--cookies', '/secrets/cookies.txt',
      '--extractor-args', 'youtube:player_client=mweb,default',
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
      '--js-runtimes', 'node',
      '--config-location', '/etc/yt-dlp/config.conf',
      '--cookies', '/secrets/cookies.txt',
      '--extractor-args', 'youtube:player_client=mweb,default',
      'ytsearch1:some song'
    ],
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
      '--js-runtimes', 'node',
      '--config-location', '/etc/yt-dlp/config.conf',
      '--cookies', '/secrets/cookies.txt',
      '--extractor-args', 'youtube:player_client=mweb,default',
      'https://www.youtube.com/watch?v=abcdefghijk'
    ]
  ]);
});

test('falls back to yt-dlp when the built-in client reports a bot-check/sign-in challenge', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    createClient: async () => fakeClient({
      info: () => ({
        playability_status: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" },
        basic_info: {},
        chooseFormat: () => { throw new Error('should not be reached'); }
      })
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
  assert.ok(ytDlpInvocation, 'expected yt-dlp to be invoked as a fallback');
});

test('surfaces a bot-check/sign-in challenge as an actionable error when no yt-dlp fallback is configured', async () => {
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '',
    resolveYtDlpBinary: () => null,
    createClient: async () => fakeClient({
      info: () => ({
        playability_status: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" },
        basic_info: {},
        chooseFormat: () => { throw new Error('should not be reached'); }
      })
    })
  });

  await assert.rejects(
    resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
    (error) => {
      assert.ok(error instanceof AudioSourceError);
      assert.match(error.message, /not a bot/i);
      return true;
    }
  );
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

test('resolveYtDlpJsRuntimes resolves default node, trimmed strings, arrays, and none/empty', () => {
  assert.equal(resolveYtDlpJsRuntimes(undefined), DEFAULT_YT_DLP_JS_RUNTIMES);
  assert.equal(resolveYtDlpJsRuntimes(null), null);
  assert.equal(resolveYtDlpJsRuntimes(''), null);
  assert.equal(resolveYtDlpJsRuntimes('   '), null);
  assert.equal(resolveYtDlpJsRuntimes('none'), null);
  assert.equal(resolveYtDlpJsRuntimes('NONE'), null);
  assert.equal(resolveYtDlpJsRuntimes('node'), 'node');
  assert.equal(resolveYtDlpJsRuntimes('  node , quickjs  '), 'node , quickjs');
  assert.equal(resolveYtDlpJsRuntimes(['node', 'deno']), 'node,deno');
  assert.equal(resolveYtDlpJsRuntimes(['  node  ', '']), 'node');
  assert.equal(resolveYtDlpJsRuntimes([]), null);
});

test('resolveYtDlpPlayerClient resolves defaults, trimmed strings, and none/empty', () => {
  assert.equal(resolveYtDlpPlayerClient(undefined), DEFAULT_YT_DLP_PLAYER_CLIENT);
  assert.equal(resolveYtDlpPlayerClient(null), null);
  assert.equal(resolveYtDlpPlayerClient('  mweb,tv  '), 'mweb,tv');
  assert.equal(resolveYtDlpPlayerClient(''), null);
  assert.equal(resolveYtDlpPlayerClient('   '), null);
  assert.equal(resolveYtDlpPlayerClient('none'), null);
  assert.equal(resolveYtDlpPlayerClient('NONE'), null);
});

test('resolveYtDlpPoToken, resolveYtDlpPotProviderUrl, and resolveYtDlpExtractorArgs trim values and return null when unset', () => {
  assert.equal(resolveYtDlpPoToken(undefined), null);
  assert.equal(resolveYtDlpPoToken(''), null);
  assert.equal(resolveYtDlpPoToken('  web+token123  '), 'web+token123');

  assert.equal(resolveYtDlpPotProviderUrl(undefined), null);
  assert.equal(resolveYtDlpPotProviderUrl(''), null);
  assert.equal(resolveYtDlpPotProviderUrl('  http://provider.local:4444  '), 'http://provider.local:4444');

  assert.equal(resolveYtDlpExtractorArgs(undefined), null);
  assert.equal(resolveYtDlpExtractorArgs(''), null);
  assert.equal(resolveYtDlpExtractorArgs('  youtube:player_client=android  '), 'youtube:player_client=android');
});

test('sanitizeDetails masks sensitive tokens and po_token arguments', () => {
  const secret = 'SUPER_SECRET_PO_TOKEN_12345';
  const raw = `Command failed: yt-dlp --extractor-args youtube:po_token=${secret} ERROR: ${secret}`;
  const sanitized = sanitizeDetails(raw, [secret]);

  assert.equal(sanitized.includes(secret), false);
  assert.match(sanitized, /\[REDACTED\]/);
  assert.equal(sanitizeDetails(null), '');
  assert.equal(sanitizeDetails('plain error without secrets'), 'plain error without secrets');
});

test('yt-dlp fallback resolution passes custom PO-token and provider as discrete argv entries', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPoToken: 'my_po_token_xyz',
    ytDlpPotProviderUrl: 'http://pot.local:4444',
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
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=mweb,default',
      '--extractor-args', 'youtube:po_token=my_po_token_xyz',
      '--extractor-args', 'youtube:pot-provider=bgutil+http://pot.local:4444',
      'https://youtube.com/watch?v=abcdefghijk'
    ],
    { timeout: 30_000 }
  ]);
});

test('yt-dlp fallback resolution does not duplicate bgutil+ prefix if already present', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPotProviderUrl: 'bgutil+http://pot.local:4444',
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');

  assert.ok(ytDlpInvocation[1].includes('youtube:pot-provider=bgutil+http://pot.local:4444'));
  assert.ok(!ytDlpInvocation[1].includes('bgutil+bgutil+'));
});

test('yt-dlp fallback resolution omits player_client when explicitly set to null/none', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPlayerClient: null,
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
      '--js-runtimes', 'node',
      'https://youtube.com/watch?v=abcdefghijk'
    ],
    { timeout: 30_000 }
  ]);
});

test('custom extractor args override default player_client and pass discrete entries', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpExtractorArgs: ['youtube:player_client=android', 'generic:foo=bar'],
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
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=android',
      '--extractor-args', 'generic:foo=bar',
      'https://youtube.com/watch?v=abcdefghijk'
    ],
    { timeout: 30_000 }
  ]);
});

test('yt-dlp fallback masks sensitive po_token in error messages and diagnostics', async () => {
  const secretToken = 'VERY_SECRET_TOKEN_12345';
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPoToken: secretToken,
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async () => {
      const err = new Error(`Command failed: yt-dlp --extractor-args youtube:po_token=${secretToken}`);
      err.stderr = `ERROR: [youtube] Sign in to confirm you’re not a bot with token ${secretToken}`;
      throw err;
    }
  });

  await assert.rejects(
    resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
    (error) => {
      assert.ok(error instanceof AudioSourceError);
      assert.equal(error.message.includes(secretToken), false, 'secret token must not appear in error.message');
      assert.match(error.message, /\[REDACTED\]/);
      assert.match(error.message, /Sign in to confirm you’re not a bot/);
      return true;
    }
  );
});

test('yt-dlp fallback maps unavailable/private errors to UserInputError and preserves others as AudioSourceError', async () => {
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async () => {
      const err = new Error('yt-dlp execution failed');
      err.stderr = 'ERROR: [youtube] abcdefghijk: Private video. Sign in if you’ve been granted access';
      throw err;
    }
  });

  await assert.rejects(
    resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
    (error) => {
      assert.ok(error instanceof UserInputError);
      assert.match(error.message, /unavailable, private, or region-restricted/);
      return true;
    }
  );

  const genericResolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async () => {
      const err = new Error('yt-dlp execution failed');
      err.stderr = 'ERROR: [youtube] abcdefghijk: HTTP Error 403: Forbidden';
      throw err;
    }
  });

  await assert.rejects(
    genericResolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
    (error) => {
      assert.ok(error instanceof AudioSourceError);
      assert.match(error.message, /HTTP Error 403: Forbidden/);
      return true;
    }
  );
});

test('yt-dlp fallback resolution passes custom js-runtimes or omits when explicitly set to null/none', async () => {
  let ytDlpInvocation;
  const resolverWithNone = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpJsRuntimes: null,
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await resolverWithNone.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');
  assert.ok(!ytDlpInvocation[1].includes('--js-runtimes'));

  const resolverWithMultiple = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpJsRuntimes: ['node', 'quickjs'],
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await resolverWithMultiple.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');
  assert.deepEqual(ytDlpInvocation[1].slice(0, 9), [
    '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
    '--js-runtimes', 'node',
    '--js-runtimes', 'quickjs'
  ]);
});


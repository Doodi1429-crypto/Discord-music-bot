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
  fullErrorDetails,
  runYtDlp,
  DEFAULT_YT_DLP_JS_RUNTIMES,
  DEFAULT_YT_DLP_PLAYER_CLIENT
} from '../src/resolvers/YouTubeResolver.js';
import { YT_DLP_DEFAULT_PATH } from '../src/resolvers/ytDlpPaths.js';
import { BGUTIL_PROVIDER_PLUGIN_DIR } from '../src/resolvers/ytDlpPaths.js';
import { UserInputError, AudioSourceError } from '../src/utils/errors.js';
import { logger } from '../src/utils/logger.js';

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
    ytDlpPotProviderEnabled: false,
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
      'https://youtube.com/watch?v=abcdefghijk'
    ],
    { timeout: 30_000 }
  ]);
});

test('search falls back to yt-dlp only after built-in search fails', async () => {
  const invocations = [];
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPotProviderEnabled: false,
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
      'ytsearch1:some song'
    ],
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
      '--js-runtimes', 'node',
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
    ytDlpPotProviderEnabled: false,
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
    ytDlpPotProviderEnabled: false,
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
      'ytsearch1:some song'
    ],
    [
      '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
      '--js-runtimes', 'node',
      '--config-location', '/etc/yt-dlp/config.conf',
      '--cookies', '/secrets/cookies.txt',
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
  assert.equal(resolveYtDlpPlayerClient(undefined, false), null);
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

  assert.equal(resolveYtDlpPotProviderUrl(undefined), 'http://127.0.0.1:4416');
  assert.equal(resolveYtDlpPotProviderUrl(''), 'http://127.0.0.1:4416');
  assert.equal(resolveYtDlpPotProviderUrl('  http://127.0.0.1:4444  '), 'http://127.0.0.1:4444');

  assert.equal(resolveYtDlpExtractorArgs(undefined), null);
  assert.equal(resolveYtDlpExtractorArgs(''), null);
  assert.equal(resolveYtDlpExtractorArgs('  youtube:player_client=android  '), 'youtube:player_client=android');
  assert.throws(
    () => resolveYtDlpExtractorArgs('youtubepot-bgutilhttp:base_url=http://provider.example:4416'),
    /local HTTP service/
  );
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

test('sanitizeDetails redacts token, cookie, credential, and authorization formats', () => {
  const bearerSecret = ['BEARER', 'SECRET'].join('_');
  const urlPassword = ['PASS', 'SECRET'].join('_');
  const raw = [
    'youtube:po_token=PO_SECRET access_token=ACCESS_SECRET api_key=KEY_SECRET',
    "--cookies '/private/cookies.txt' --cookies-from-browser firefox --password CLI_SECRET",
    'Cookie: SID=COOKIE_SECRET; auth=COOKIE_AUTH',
    'Authorization: Bearer ' + bearerSecret,
    'https://user:' + urlPassword + '@example.test/audio?token=URL_SECRET',
    '.youtube.com TRUE / TRUE 123 SID NETSCAPE_COOKIE_SECRET'
  ].join('\n');
  const sanitized = sanitizeDetails(raw);

  for (const secret of [
    'PO_SECRET', 'ACCESS_SECRET', 'KEY_SECRET', '/private/cookies.txt', 'firefox',
    'CLI_SECRET', 'COOKIE_SECRET', 'COOKIE_AUTH', bearerSecret, `user:${urlPassword}`,
    'URL_SECRET', 'NETSCAPE_COOKIE_SECRET'
  ]) {
    assert.equal(sanitized.includes(secret), false, `expected ${secret} to be redacted`);
  }
  assert.equal(errorDetails({ message: raw }).includes('COOKIE_SECRET'), false);
  assert.equal(sanitizeDetails('Generated POT: GENERATED_PO_TOKEN_VALUE'), 'Generated POT: [REDACTED]');
});

test('errorDetails reduces verbose multi-line yt-dlp diagnostics to a short final-error summary, while fullErrorDetails preserves everything', () => {
  const secret = 'SUPER_SECRET_PO_TOKEN_12345';
  const verboseStderr = [
    '[debug] Command-line config: [\'--verbose\', \'--dump-single-json\']',
    '[debug] yt-dlp version 2024.01.01',
    `[debug] Loaded plugin bgutil-ytdlp-pot-provider from http://127.0.0.1:4416`,
    '[debug] [youtube] Extracting URL: https://youtube.com/watch?v=abcdefghijk',
    `[debug] po_token=${secret}`,
    'ERROR: [youtube] abcdefghijk: Sign in to confirm you\u2019re not a bot'
  ].join('\n');
  const error = { stderr: verboseStderr };

  const summary = errorDetails(error, [secret]);
  assert.equal(summary.includes(secret), false, 'secret must not appear in the short summary');
  assert.equal(summary, 'ERROR: [youtube] abcdefghijk: Sign in to confirm you\u2019re not a bot');
  assert.ok(summary.length < 200, 'the Discord-facing summary should be short, not the full verbose transcript');

  const full = fullErrorDetails(error, [secret]);
  assert.equal(full.includes(secret), false, 'secret must not appear in full diagnostics either');
  assert.match(full, /bgutil-ytdlp-pot-provider/);
  assert.match(full, /http:\/\/127\.0\.0\.1:4416/);
  assert.match(full, /Extracting URL/);
  assert.match(full, /Sign in to confirm you\u2019re not a bot$/);
});

test('errorDetails finds a tag-prefixed ERROR line (e.g. "[download] ERROR: ...") instead of falling back to the last unrelated line', () => {
  const stderr = [
    '[debug] yt-dlp version 2024.01.01',
    '[download] ERROR: unable to download video data: HTTP Error 403: Forbidden',
    '[debug] cleaning up temporary files'
  ].join('\n');

  const summary = errorDetails({ stderr });
  assert.equal(summary, 'ERROR: unable to download video data: HTTP Error 403: Forbidden');
});

test('errorDetails ignores benign lines that merely mention the word "error" without yt-dlp\'s ERROR: marker', () => {
  const stderr = [
    '[debug] retrying after error: connection reset, continuing',
    'ERROR: [youtube] abcdefghijk: Video unavailable'
  ].join('\n');

  const summary = errorDetails({ stderr });
  assert.equal(summary, 'ERROR: [youtube] abcdefghijk: Video unavailable');
});

test('errorDetails does not match "ERROR:" appearing mid-line after an unrelated bracket', () => {
  const stderr = [
    '[debug] something ] look ERROR: nope, this is not a real yt-dlp error line',
    'network timeout while connecting to video host'
  ].join('\n');

  const summary = errorDetails({ stderr });
  assert.equal(summary, 'network timeout while connecting to video host');
});

test('errorDetails picks the last of multiple ERROR: lines, treating it as the final/fatal error', () => {
  const stderr = [
    'ERROR: [youtube] abcdefghijk: Unable to download webpage (retrying)',
    '[debug] retrying download',
    'ERROR: [youtube] abcdefghijk: HTTP Error 403: Forbidden'
  ].join('\n');

  const summary = errorDetails({ stderr });
  assert.equal(summary, 'ERROR: [youtube] abcdefghijk: HTTP Error 403: Forbidden');
});

test('YOUTUBE_DL_DEBUG gates verbose invocation and diagnostic metadata', async () => {
  const previousDebug = process.env.YOUTUBE_DL_DEBUG;
  const previousPoToken = process.env.YOUTUBE_DL_PO_TOKEN;
  const secret = 'PO_TOKEN_MUST_NOT_BE_REPORTED';
  const invocations = [];
  const createResolver = () => new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPoToken: secret,
    ytDlpCookiesPath: '/private/cookies.txt',
    createClient: async () => fakeClient({
      info: () => { throw new Error('Sign in to confirm you are not a bot'); }
    }),
    ytDlpRunner: async (binary, args, options) => {
      invocations.push({ binary, args, options });
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/audio', acodec: 'opus' };
    }
  });

  try {
    delete process.env.YOUTUBE_DL_DEBUG;
    process.env.YOUTUBE_DL_PO_TOKEN = secret;
    await createResolver().resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');
    assert.equal(invocations[0].args.includes('--verbose'), false);
    assert.deepEqual(invocations[0].options, { timeout: 30_000 });

    process.env.YOUTUBE_DL_DEBUG = 'true';
    await createResolver().resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');
    const debugInvocation = invocations[1];
    assert.equal(debugInvocation.args.includes('--verbose'), true);
    assert.equal(debugInvocation.args.includes('--no-warnings'), false);
    assert.equal(debugInvocation.options.debug, true);
    assert.equal(debugInvocation.options.diagnostics.cookiesConfigured, true);
    assert.equal(debugInvocation.options.diagnostics.extractorConfiguration.includes(secret), false);
    assert.equal(JSON.stringify(debugInvocation.options.diagnostics).includes('/private/cookies.txt'), false);
  } finally {
    if (previousDebug === undefined) delete process.env.YOUTUBE_DL_DEBUG;
    else process.env.YOUTUBE_DL_DEBUG = previousDebug;
    if (previousPoToken === undefined) delete process.env.YOUTUBE_DL_PO_TOKEN;
    else process.env.YOUTUBE_DL_PO_TOKEN = previousPoToken;
  }
});

test('runYtDlp reports sanitized runtime diagnostics and final exit code only in debug mode', async () => {
  const originalInfo = logger.info;
  const calls = [];
  const reports = [];
  const bearerSecret = ['BEARER', 'SECRET'].join('_');
  const fakeExecFile = (binary, args, options, callback) => {
    calls.push(args);
    if (args[0] === '--version') {
      callback(null, '2026.09.29\n', '');
      return;
    }
    const error = Object.assign(new Error('yt-dlp command failed'), { code: 1 });
    callback(error, '', [
      '[debug] JS runtimes: node',
      '[debug] yt-dlp-ejs available',
      '[debug] PO Token provider available',
      '[debug] youtube player_client=web,default',
      '[debug] PO Token is required',
      "--cookies '/private/cookies.txt' youtube:po_token=PO_SECRET",
      'Cookie: SID=COOKIE_SECRET',
      'Authorization: Bearer ' + bearerSecret
    ].join('\n'));
  };

  try {
    logger.info = (message, details) => reports.push({ message, details });
    await assert.rejects(runYtDlp('/configured/yt-dlp', ['--dump-single-json'], {
      timeout: 100,
      execFileImpl: fakeExecFile
    }));
    assert.deepEqual(calls, [['--dump-single-json']]);
    assert.equal(reports.length, 0);

    calls.length = 0;
    await assert.rejects(runYtDlp('/configured/yt-dlp', ['--verbose', '--dump-single-json'], {
      timeout: 100,
      debug: true,
      execFileImpl: fakeExecFile,
      sensitiveValues: ['PO_SECRET'],
      diagnostics: {
        configuredJsRuntimes: 'node',
        configuredPlayerClient: null,
        challengeProviderConfigured: false,
        poTokenConfigured: true,
        extractorConfiguration: 'youtube:po_token=[REDACTED]',
        configFileConfigured: false,
        cookiesConfigured: false
      }
    }));

    assert.deepEqual(calls, [['--version'], ['--verbose', '--dump-single-json']]);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].message, 'yt-dlp diagnostic report');
    assert.equal(reports[0].details.ytDlpVersion, '2026.09.29');
    assert.equal(reports[0].details.nodeVersion, process.version);
    assert.deepEqual(reports[0].details.detectedJsRuntimeOutput, ['[debug] JS runtimes: node']);
    assert.equal(reports[0].details.ejsAvailability, 'available');
    assert.equal(reports[0].details.challengeProviderAvailability, 'available');
    assert.deepEqual(reports[0].details.reportedPlayerClients, ['[debug] youtube player_client=web,default']);
    assert.equal(reports[0].details.playerClientPolicy, 'yt-dlp default');
    assert.equal(reports[0].details.poTokenRequired, true);
    assert.equal(reports[0].details.exitCode, 1);

    const report = JSON.stringify(reports[0]);
    for (const secret of ['PO_SECRET', '/private/cookies.txt', 'COOKIE_SECRET', 'BEARER_SECRET']) {
      assert.equal(report.includes(secret), false, `expected ${secret} to be absent from diagnostic report`);
    }
    assert.match(reports[0].details.errorOutput, /Cookie: \[REDACTED\]/);
    assert.match(reports[0].details.errorOutput, /Authorization: \[REDACTED\]/);
  } finally {
    logger.info = originalInfo;
  }
});

test('yt-dlp fallback resolution passes custom PO-token and provider as discrete argv entries', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPoToken: 'my_po_token_xyz',
    ytDlpPotProviderUrl: 'http://127.0.0.1:4444',
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
      '--plugin-dirs', BGUTIL_PROVIDER_PLUGIN_DIR,
      '--extractor-args', 'youtube:player_client=mweb',
      '--extractor-args', 'youtube:po_token=my_po_token_xyz',
      '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4444',
      'https://youtube.com/watch?v=abcdefghijk'
    ],
    { timeout: 30_000 }
  ]);
});

test('yt-dlp fallback uses the upstream bgutil HTTP provider configuration', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPotProviderUrl: 'http://127.0.0.1:4444',
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');

  assert.ok(ytDlpInvocation[1].includes('youtubepot-bgutilhttp:base_url=http://127.0.0.1:4444'));
  assert.ok(ytDlpInvocation[1].includes('--plugin-dirs'));
});

test('yt-dlp fallback requests provider-backed mweb PO tokens by default', async () => {
  let ytDlpInvocation;
  const defaultResolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await defaultResolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');

  assert.equal(ytDlpInvocation[1].includes('--plugin-dirs'), true);
  assert.ok(ytDlpInvocation[1].includes('--extractor-args'));
  assert.ok(ytDlpInvocation[1].includes('youtube:player_client=mweb'));
  assert.ok(ytDlpInvocation[1].includes('youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'));

  const nullResolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPlayerClient: null,
    ytDlpPotProviderEnabled: false,
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await nullResolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');
  assert.ok(!ytDlpInvocation[1].includes('--extractor-args'));

  const noneResolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPlayerClient: 'none',
    ytDlpPotProviderEnabled: false,
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await noneResolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');
  assert.ok(!ytDlpInvocation[1].includes('--extractor-args'));
});

test('yt-dlp fallback resolution passes explicit player_client override when configured', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPlayerClient: 'mweb',
    ytDlpPotProviderEnabled: false,
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
      '--extractor-args', 'youtube:player_client=mweb',
      'https://youtube.com/watch?v=abcdefghijk'
    ],
    { timeout: 30_000 }
  ]);

  const resolverWithFallback = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPlayerClient: 'mweb,default',
    ytDlpPotProviderEnabled: false,
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await resolverWithFallback.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');

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

test('custom extractor args override explicit player_client and pass discrete entries', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPlayerClient: 'mweb',
    ytDlpPotProviderEnabled: false,
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

test('custom extractor args preserve explicit player_client when not overridden', async () => {
  let ytDlpInvocation;
  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPlayerClient: 'mweb',
    ytDlpExtractorArgs: 'generic:foo=bar',
    ytDlpPotProviderEnabled: false,
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
      '--extractor-args', 'youtube:player_client=mweb',
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

test('yt-dlp fallback keeps the Discord-facing error short while logging full verbose diagnostics to Render logs', async () => {
  const secretToken = 'ANOTHER_SECRET_TOKEN_98765';
  const verboseStderr = [
    '[debug] Command-line config: [\'--verbose\', \'--dump-single-json\']',
    '[debug] Loaded plugin bgutil-ytdlp-pot-provider from http://127.0.0.1:4416',
    `[debug] po_token=${secretToken}`,
    'ERROR: [youtube] abcdefghijk: HTTP Error 403: Forbidden'
  ].join('\n');

  const resolver = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpPoToken: secretToken,
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async () => {
      const err = new Error('yt-dlp execution failed');
      err.stderr = verboseStderr;
      throw err;
    }
  });

  const originalError = logger.error;
  const loggedCalls = [];
  logger.error = (message, meta) => loggedCalls.push({ message, meta });
  try {
    await assert.rejects(
      resolver.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk'),
      (error) => {
        assert.ok(error instanceof AudioSourceError);
        assert.equal(error.message.includes(secretToken), false);
        assert.equal(error.message.includes('[debug]'), false, 'full verbose preamble must not reach Discord');
        assert.match(error.message, /HTTP Error 403: Forbidden$/);
        assert.ok(error.message.length < 200, 'Discord-facing message should be a short summary');
        return true;
      }
    );
  } finally {
    logger.error = originalError;
  }

  const fallbackLog = loggedCalls.find((call) => call.message === 'yt-dlp fallback resolution failed');
  assert.ok(fallbackLog, 'expected the full diagnostics to be logged');
  assert.equal(fallbackLog.meta.message.includes(secretToken), false);
  assert.match(fallbackLog.meta.message, /bgutil-ytdlp-pot-provider/);
  assert.match(fallbackLog.meta.message, /http:\/\/127\.0\.0\.1:4416/);
  assert.match(fallbackLog.meta.message, /HTTP Error 403: Forbidden/);
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
    ytDlpJsRuntimes: 'none',
    ytDlpPlayerClient: 'none',
    ytDlpPotProviderEnabled: false,
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
  assert.ok(!ytDlpInvocation[1].includes('--extractor-args'));

  const resolverWithMultiple = new YouTubeResolver({
    ytDlpBinaryPath: '/configured/yt-dlp',
    ytDlpJsRuntimes: ['node', 'quickjs'],
    ytDlpPotProviderEnabled: false,
    createClient: async () => fakeClient({
      info: () => { throw new Error('YouTube blocked this request'); }
    }),
    ytDlpRunner: async (...args) => {
      ytDlpInvocation = args;
      return { title: 'Fallback video', duration: 10, url: 'https://media.example/fallback', acodec: 'opus' };
    }
  });

  await resolverWithMultiple.resolveVideoUrl('https://youtube.com/watch?v=abcdefghijk');
  assert.deepEqual(ytDlpInvocation[1].slice(0, 7), [
    '--dump-single-json', '--no-warnings', '--format', 'bestaudio/best', '--no-playlist',
    '--js-runtimes', 'node,quickjs'
  ]);
});

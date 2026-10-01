import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installYtDlp, ASSET_BY_PLATFORM } from '../scripts/install-yt-dlp.js';

/** Captures log/warn/fail output for assertions without touching the real console. */
function fakeLogger() {
  const logs = [];
  const warns = [];
  const fails = [];
  return {
    log: (message) => logs.push(message),
    warn: (message) => warns.push(message),
    fail: (message) => fails.push(message),
    logs,
    warns,
    fails
  };
}

test('installYtDlp skips entirely when YOUTUBE_DL_SKIP_INSTALL is set', async () => {
  const logger = fakeLogger();
  const result = await installYtDlp({
    env: { YOUTUBE_DL_SKIP_INSTALL: '1' },
    download: () => assert.fail('should not attempt a download'),
    ...logger
  });

  assert.equal(result.outcome, 'skipped-by-env');
  assert.equal(logger.fails.length, 0);
});

test('installYtDlp skips auto-install and uses YOUTUBE_DL_PATH when set and executable', async () => {
  const logger = fakeLogger();
  const result = await installYtDlp({
    env: { YOUTUBE_DL_PATH: '/configured/yt-dlp' },
    checkExecutable: async (path) => path === '/configured/yt-dlp',
    download: () => assert.fail('should not attempt a download'),
    ...logger
  });

  assert.deepEqual(result, { outcome: 'override-used', path: '/configured/yt-dlp' });
  assert.equal(logger.fails.length, 0);
});

test('installYtDlp warns (but does not fail) when YOUTUBE_DL_PATH is set but missing', async () => {
  const logger = fakeLogger();
  const result = await installYtDlp({
    env: { YOUTUBE_DL_PATH: '/configured/yt-dlp' },
    checkExecutable: async () => false,
    download: () => assert.fail('should not attempt a download'),
    ...logger
  });

  assert.equal(result.outcome, 'override-missing');
  assert.equal(logger.fails.length, 0);
  assert.match(logger.warns[0], /not executable yet/);
});

test('installYtDlp warns (but does not fail) on an unsupported platform/arch', async () => {
  const logger = fakeLogger();
  const result = await installYtDlp({
    env: {},
    platform: 'freebsd',
    arch: 'x64',
    download: () => assert.fail('should not attempt a download'),
    ...logger
  });

  assert.deepEqual(result, { outcome: 'unsupported-platform', platformKey: 'freebsd-x64' });
  assert.equal(logger.fails.length, 0);
  assert.match(logger.warns[0], /No prebuilt yt-dlp binary/);
});

test('installYtDlp skips the download when an existing binary already verifies successfully', async () => {
  const logger = fakeLogger();
  const result = await installYtDlp({
    env: {},
    platform: 'linux',
    arch: 'x64',
    checkExecutable: async () => true,
    getVersion: async () => '2026.01.01',
    download: () => assert.fail('should not attempt a download'),
    ...logger
  });

  assert.equal(result.outcome, 'already-installed');
  assert.equal(result.version, '2026.01.01');
});

test('installYtDlp reinstalls when an existing binary fails to verify', async () => {
  const logger = fakeLogger();
  let downloaded = false;
  let removed = false;
  let versionCalls = 0;
  const result = await installYtDlp({
    env: {},
    platform: 'linux',
    arch: 'x64',
    checkExecutable: async () => true,
    getVersion: async () => {
      versionCalls += 1;
      if (versionCalls === 1) throw new Error('corrupt binary');
      return '2026.01.01';
    },
    removeFile: async () => { removed = true; },
    download: async () => { downloaded = true; },
    ...logger
  });

  assert.equal(removed, true);
  assert.equal(downloaded, true);
  assert.equal(result.outcome, 'installed');
});

test('installYtDlp downloads and verifies a fresh binary for a supported platform', async () => {
  const logger = fakeLogger();
  let downloadedAsset;
  const result = await installYtDlp({
    env: {},
    platform: 'linux',
    arch: 'x64',
    destinationPath: '/fake/bin/yt-dlp',
    checkExecutable: async () => false,
    getVersion: async () => '2026.01.01',
    download: async (assetName, destinationPath) => {
      downloadedAsset = { assetName, destinationPath };
    },
    ...logger
  });

  assert.equal(downloadedAsset.assetName, ASSET_BY_PLATFORM['linux-x64']);
  assert.equal(downloadedAsset.destinationPath, '/fake/bin/yt-dlp');
  assert.deepEqual(result, { outcome: 'installed', path: '/fake/bin/yt-dlp', version: '2026.01.01' });
});

test('installYtDlp reports an actionable, failing outcome when the download fails', async () => {
  const logger = fakeLogger();
  const result = await installYtDlp({
    env: {},
    platform: 'linux',
    arch: 'x64',
    checkExecutable: async () => false,
    download: async () => { throw new Error('HTTP 404'); },
    ...logger
  });

  assert.equal(result.outcome, 'download-failed');
  assert.ok(logger.fails.length > 0);
  assert.match(logger.fails[0], /Failed to download yt-dlp/);
  assert.match(logger.fails[0], /YOUTUBE_DL_SKIP_INSTALL/);
});

test('installYtDlp reports an actionable, failing outcome when the downloaded binary cannot run', async () => {
  const logger = fakeLogger();
  const result = await installYtDlp({
    env: {},
    platform: 'linux',
    arch: 'x64',
    checkExecutable: async () => false,
    download: async () => {},
    getVersion: async () => { throw new Error('exec format error'); },
    ...logger
  });

  assert.equal(result.outcome, 'verify-failed');
  assert.ok(logger.fails.length > 0);
  assert.match(logger.fails[0], /failed to execute it/);
});

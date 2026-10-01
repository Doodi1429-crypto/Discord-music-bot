#!/usr/bin/env node
// Automatically downloads a prebuilt yt-dlp binary for the current platform during
// `npm install`, so Render's default build step (npm install) makes the optional
// yt-dlp fallback used by YouTubeResolver actually available without any Render
// Shell access or manual installation step.
//
// This intentionally does NOT use the GitHub API (which has low unauthenticated
// rate limits); it downloads directly from the stable
// `.../releases/latest/download/<asset>` redirect, which requires no token/auth.
//
// Opt-outs (no credentials/bypasses involved, just configuration):
//   - YOUTUBE_DL_PATH: if set, this script assumes the operator manages their own
//     yt-dlp/youtube-dl binary and skips downloading entirely.
//   - YOUTUBE_DL_SKIP_INSTALL=1: explicitly skip auto-install (e.g. offline dev,
//     intentionally running without the yt-dlp fallback).
import { access as fsAccess, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { YT_DLP_BIN_DIR, YT_DLP_DEFAULT_PATH } from '../src/resolvers/ytDlpPaths.js';

const execFileAsync = promisify(execFile);

export const RELEASE_DOWNLOAD_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

// Standalone (no Python dependency) prebuilt binaries published with every yt-dlp
// release. See https://github.com/yt-dlp/yt-dlp#release-files
export const ASSET_BY_PLATFORM = {
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'win32-x64': 'yt-dlp.exe'
};

const PREFIX = '[install-yt-dlp]';

async function isExecutableFile(path) {
  try {
    await fsAccess(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function binaryVersion(path) {
  const { stdout } = await execFileAsync(path, ['--version'], { timeout: 15_000, encoding: 'utf8' });
  return stdout.trim();
}

async function downloadAsset(assetName, destinationPath) {
  const url = `${RELEASE_DOWNLOAD_BASE}/${assetName}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status} ${response.statusText} (${url})`);
  }

  await mkdir(YT_DLP_BIN_DIR, { recursive: true });
  const tmpPath = `${destinationPath}.download`;
  await pipeline(response.body, createWriteStream(tmpPath));
  await rename(tmpPath, destinationPath);
  if (process.platform !== 'win32') {
    await chmod(destinationPath, 0o755);
  }
}

/**
 * Runs the install, with every external effect (env, platform/arch, fs/process access,
 * download, and logging) injectable so this can be exercised by focused tests without
 * touching the network, the real filesystem, or spawning a real process.
 *
 * Returns a result object describing what happened ({ outcome, ... }) instead of calling
 * process.exit() directly, so tests can assert on behavior; the CLI entry point below
 * (invoked only when this file is run directly) is what actually sets process.exitCode.
 */
export async function installYtDlp({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  destinationPath = YT_DLP_DEFAULT_PATH,
  assetByPlatform = ASSET_BY_PLATFORM,
  checkExecutable = isExecutableFile,
  getVersion = binaryVersion,
  download = downloadAsset,
  removeFile = (path) => rm(path, { force: true }),
  log = (message) => console.log(`${PREFIX} ${message}`),
  warn = (message) => console.warn(`${PREFIX} ${message}`),
  fail = (message) => console.error(`${PREFIX} ${message}`)
} = {}) {
  if (env.YOUTUBE_DL_SKIP_INSTALL?.trim()) {
    log('YOUTUBE_DL_SKIP_INSTALL is set; skipping automatic yt-dlp install.');
    return { outcome: 'skipped-by-env' };
  }

  const overridePath = env.YOUTUBE_DL_PATH?.trim();
  if (overridePath) {
    log(`YOUTUBE_DL_PATH is set to "${overridePath}"; skipping automatic install and using the configured path.`);
    if (!(await checkExecutable(overridePath))) {
      warn(
        `YOUTUBE_DL_PATH is set to "${overridePath}", but that file does not exist or is not executable yet. `
        + 'The yt-dlp fallback will be unavailable until a valid, executable binary is present there.'
      );
      return { outcome: 'override-missing', path: overridePath };
    }
    return { outcome: 'override-used', path: overridePath };
  }

  const platformKey = `${platform}-${arch}`;
  const assetName = assetByPlatform[platformKey];
  if (!assetName) {
    warn(
      `No prebuilt yt-dlp binary is published for platform "${platformKey}". `
      + 'YouTube playback will rely solely on the built-in youtubei.js resolver (yt-dlp fallback disabled) '
      + 'unless you install yt-dlp yourself and set YOUTUBE_DL_PATH to its location.'
    );
    return { outcome: 'unsupported-platform', platformKey };
  }

  if (await checkExecutable(destinationPath)) {
    try {
      const version = await getVersion(destinationPath);
      log(`yt-dlp ${version} is already installed at ${destinationPath}; skipping download.`);
      return { outcome: 'already-installed', path: destinationPath, version };
    } catch {
      warn(`Existing binary at ${destinationPath} failed to run; reinstalling.`);
      await removeFile(destinationPath);
    }
  }

  log(`Downloading yt-dlp (${assetName}) for ${platformKey}...`);
  try {
    await download(assetName, destinationPath);
  } catch (error) {
    fail(
      `Failed to download yt-dlp: ${error.message}. The yt-dlp fallback used by YouTubeResolver will be `
      + 'unavailable, which may cause playback failures for videos that require it (e.g. YouTube '
      + "bot-check/sign-in challenges such as \"Sign in to confirm you're not a bot\"). To resolve: ensure "
      + 'outbound network access to github.com is allowed during the build, set YOUTUBE_DL_PATH to a '
      + 'yt-dlp binary you install/manage yourself, or set YOUTUBE_DL_SKIP_INSTALL=1 to intentionally '
      + 'deploy without this fallback.'
    );
    return { outcome: 'download-failed', error };
  }

  try {
    const version = await getVersion(destinationPath);
    log(`yt-dlp ${version} installed at ${destinationPath}.`);
    return { outcome: 'installed', path: destinationPath, version };
  } catch (error) {
    fail(
      `Downloaded yt-dlp but failed to execute it (${error.message}). This usually means the downloaded `
      + 'binary is incompatible with this host. Set YOUTUBE_DL_PATH to a working yt-dlp binary, or set '
      + 'YOUTUBE_DL_SKIP_INSTALL=1 to deploy without the yt-dlp fallback.'
    );
    return { outcome: 'verify-failed', error };
  }
}

// Outcomes that should make `npm install` (and therefore a Render build relying on its
// default build command) fail clearly rather than silently deploy without yt-dlp.
const FAILING_OUTCOMES = new Set(['download-failed', 'verify-failed']);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installYtDlp()
    .then((result) => {
      if (FAILING_OUTCOMES.has(result.outcome)) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`${PREFIX} Unexpected error while installing yt-dlp: ${error.message}`);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BGUTIL_PROVIDER_PLUGIN_DIR, BGUTIL_PROVIDER_ROOT } from '../src/resolvers/ytDlpPaths.js';
import { BGUTIL_PROVIDER_VERSION } from '../src/resolvers/ytDlpPotProvider.js';

export const PROVIDER_ARCHIVE_URL =
  `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_PROVIDER_VERSION}.tar.gz`;
export const PROVIDER_PLUGIN_ARCHIVE_URL =
  `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_PROVIDER_VERSION}/bgutil-ytdlp-pot-provider.zip`;
export const PROVIDER_PLUGIN_ARCHIVE_NAME = 'bgutil-ytdlp-pot-provider.zip';
export const SAFE_AXIOS_VERSION = '1.20.0';

const PREFIX = '[install-bgutil-provider]';

function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code ?? 'unknown'}.`));
    });
  });
}

async function hasProviderFiles(rootPath) {
  try {
    const packageJson = JSON.parse(await readFile(join(rootPath, 'server', 'package.json'), 'utf8'));
    await access(join(rootPath, 'server', 'node_modules', 'express'), fsConstants.R_OK);
    await access(join(rootPath, 'server', 'build', 'main.js'), fsConstants.R_OK);
    await access(join(rootPath, PROVIDER_PLUGIN_ARCHIVE_NAME), fsConstants.R_OK);
    return packageJson.version === BGUTIL_PROVIDER_VERSION
      && packageJson.overrides?.axios === SAFE_AXIOS_VERSION;
  } catch {
    return false;
  }
}

async function isInstalled(rootPath, pluginDir) {
  if (!(await hasProviderFiles(rootPath))) return false;
  try {
    await access(join(pluginDir, PROVIDER_PLUGIN_ARCHIVE_NAME), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(fetchImpl, url, filePath) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Upstream provider download failed with HTTP ${response.status}.`);
  }
  await pipeline(response.body, createWriteStream(filePath, { flags: 'wx' }));
}

export async function installBgutilPotProvider({
  installRoot = BGUTIL_PROVIDER_ROOT,
  pluginDir = BGUTIL_PROVIDER_PLUGIN_DIR,
  fetchImpl = fetch,
  runCommand = run,
  installedCheck = (rootPath) => isInstalled(rootPath, pluginDir),
  log = (message) => console.log(`${PREFIX} ${message}`)
} = {}) {
  if (await installedCheck(installRoot)) {
    log(`bgutil-ytdlp-pot-provider ${BGUTIL_PROVIDER_VERSION} is already installed.`);
    return { outcome: 'already-installed', path: installRoot };
  }

  const parent = dirname(installRoot);
  const stagePath = join(parent, `.bgutil-provider-${randomUUID()}`);
  const archivePath = `${stagePath}.tar.gz`;
  await mkdir(stagePath, { recursive: true });

  try {
    await downloadFile(fetchImpl, PROVIDER_ARCHIVE_URL, archivePath);
    await runCommand('tar', ['-xzf', archivePath, '--strip-components=1', '-C', stagePath]);

    await downloadFile(
      fetchImpl,
      PROVIDER_PLUGIN_ARCHIVE_URL,
      join(stagePath, PROVIDER_PLUGIN_ARCHIVE_NAME)
    );
    const serverPath = join(stagePath, 'server');
    const manifestPath = join(serverPath, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version !== BGUTIL_PROVIDER_VERSION) {
      throw new Error('The downloaded YouTube PO-token provider version did not match the pinned release.');
    }
    manifest.dependencies.axios = SAFE_AXIOS_VERSION;
    manifest.overrides = { ...manifest.overrides, axios: SAFE_AXIOS_VERSION };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await runCommand('npm', [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund'
    ], { cwd: serverPath });
    await runCommand('npm', [
      'ci',
      '--include=dev',
      '--no-audit',
      '--no-fund'
    ], { cwd: serverPath });
    await runCommand(process.execPath, [
      join(serverPath, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      'tsconfig.json'
    ], { cwd: serverPath });
    await runCommand('npm', [
      'prune',
      '--omit=dev',
      '--no-audit',
      '--no-fund'
    ], { cwd: serverPath });

    if (!(await hasProviderFiles(stagePath))) {
      throw new Error('The upstream provider installation was incomplete.');
    }

    await rm(installRoot, { recursive: true, force: true });
    await rename(stagePath, installRoot);
    await mkdir(pluginDir, { recursive: true });
    await copyFile(
      join(installRoot, PROVIDER_PLUGIN_ARCHIVE_NAME),
      join(pluginDir, PROVIDER_PLUGIN_ARCHIVE_NAME)
    );
    log(`Installed bgutil-ytdlp-pot-provider ${BGUTIL_PROVIDER_VERSION} with the upstream plugin.`);
    return { outcome: 'installed', path: installRoot };
  } catch (error) {
    throw new Error(`Failed to install the local YouTube PO-token provider: ${error.message}`);
  } finally {
    await rm(stagePath, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installBgutilPotProvider()
    .catch((error) => {
      console.error(`${PREFIX} ${error.message}`);
      process.exitCode = 1;
    });
}

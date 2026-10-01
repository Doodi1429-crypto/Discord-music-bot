import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBgutilPotProvider, SAFE_AXIOS_VERSION } from '../scripts/install-bgutil-pot-provider.js';

test('installer pins the upstream version and patched Axios before installing dependencies', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'bgutil-provider-test-'));
  const installRoot = join(tempDir, '.bgutil-ytdlp-pot-provider');
  const pluginDir = join(tempDir, 'bin', 'yt-dlp-plugins');
  const commands = [];
  let archiveDownloaded = false;

  try {
    const result = await installBgutilPotProvider({
      installRoot,
      pluginDir,
      fetchImpl: async () => {
        archiveDownloaded = true;
        return new Response('test archive');
      },
      installedCheck: async (rootPath) => {
        try {
          await readFile(join(rootPath, 'server', 'installed.marker'));
          return true;
        } catch {
          return false;
        }
      },
      runCommand: async (command, args, options) => {
        commands.push({ command, args, options });
        if (command === 'tar') {
          const stagePath = args.at(-1);
          await mkdir(join(stagePath, 'server'), { recursive: true });
          await mkdir(join(stagePath, 'plugin', 'yt_dlp_plugins', 'extractor'), { recursive: true });
          await writeFile(join(stagePath, 'server', 'package.json'), JSON.stringify({
            version: '2.0.0',
            dependencies: { axios: '^1.19.0' }
          }));
          await writeFile(join(stagePath, 'plugin', 'yt_dlp_plugins', 'extractor', 'getpot_bgutil_http.py'), '');
        } else if (args[0] === 'install') {
          const manifest = JSON.parse(await readFile(join(options.cwd, 'package.json'), 'utf8'));
          assert.equal(manifest.dependencies.axios, SAFE_AXIOS_VERSION);
          assert.equal(manifest.overrides.axios, SAFE_AXIOS_VERSION);
        } else if (args[0] === 'ci') {
          await mkdir(join(options.cwd, 'node_modules', 'express'), { recursive: true });
          await writeFile(join(options.cwd, 'installed.marker'), 'installed');
        } else if (args.at(-1) === 'tsconfig.json') {
          await mkdir(join(options.cwd, 'build'), { recursive: true });
          await writeFile(join(options.cwd, 'build', 'main.js'), '');
        }
      }
    });

    assert.equal(archiveDownloaded, true);
    assert.equal(result.outcome, 'installed');
    const providerPackage = JSON.parse(await readFile(join(installRoot, 'server', 'package.json'), 'utf8'));
    assert.equal(providerPackage.version, '2.0.0');
    assert.equal(providerPackage.overrides.axios, SAFE_AXIOS_VERSION);
    await readFile(join(pluginDir, 'bgutil-ytdlp-pot-provider.zip'));
    assert.deepEqual(commands.slice(0, 3).map(({ command, args }) => [command, args[0]]), [
      ['tar', '-xzf'],
      ['npm', 'install'],
      ['npm', 'ci']
    ]);
    assert.equal(commands[3].command, process.execPath);
    assert.ok(commands[3].args[0].endsWith('/server/node_modules/typescript/bin/tsc'));
    assert.deepEqual([commands[4].command, commands[4].args[0]], ['npm', 'prune']);
    assert.ok(commands[2].args.includes('--include=dev'));
    assert.deepEqual(commands[1].args.slice(1), [
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund'
    ]);
    assert.ok(commands[4].args.includes('--omit=dev'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('installer cleans up temporary provider files when an install command fails', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'bgutil-provider-failure-'));
  const installRoot = join(tempDir, '.bgutil-ytdlp-pot-provider');
  const pluginDir = join(tempDir, 'bin', 'yt-dlp-plugins');

  try {
    await assert.rejects(installBgutilPotProvider({
      installRoot,
      pluginDir,
      fetchImpl: async () => new Response('test archive'),
      installedCheck: async () => false,
      runCommand: async (command, args) => {
        if (command === 'tar') {
          const stagePath = args.at(-1);
          await mkdir(join(stagePath, 'server'), { recursive: true });
          await writeFile(join(stagePath, 'server', 'package.json'), JSON.stringify({ version: '2.0.0' }));
        } else {
          throw new Error('dependency install failed');
        }
      }
    }), /Failed to install the local YouTube PO-token provider/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

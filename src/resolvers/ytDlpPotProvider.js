import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BGUTIL_PROVIDER_SERVER } from './ytDlpPaths.js';

export const BGUTIL_PROVIDER_VERSION = '2.0.0';
export const DEFAULT_YT_DLP_POT_PROVIDER_URL = 'http://127.0.0.1:4416';
export const DEFAULT_YT_DLP_POT_PROVIDER_START_TIMEOUT_MS = 10_000;

function isProviderEnabled(value = process.env.YOUTUBE_DL_POT_PROVIDER_ENABLED) {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return true;
  if (typeof value === 'string' && /^(?:true|1|yes)$/i.test(value.trim())) return true;
  if (typeof value === 'string' && /^(?:false|0|no)$/i.test(value.trim())) return false;
  throw new Error('YOUTUBE_DL_POT_PROVIDER_ENABLED must be true or false.');
}

export function resolveYtDlpPotProviderConfig({
  env = process.env,
  providerUrl = env.YOUTUBE_DL_POT_PROVIDER_URL
} = {}) {
  const enabled = isProviderEnabled(env.YOUTUBE_DL_POT_PROVIDER_ENABLED);
  const rawUrl = providerUrl?.trim() || DEFAULT_YT_DLP_POT_PROVIDER_URL;
  const configuredUrl = rawUrl.startsWith('bgutil+') ? rawUrl.slice('bgutil+'.length) : rawUrl;
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error('YOUTUBE_DL_POT_PROVIDER_URL must be a local HTTP URL.');
  }

  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('YOUTUBE_DL_POT_PROVIDER_URL must point to a local HTTP service without credentials or a path.');
  }

  const authority = configuredUrl.replace(/^http:\/\//i, '').split(/[/?#]/, 1)[0];
  const explicitPort = authority.match(/:(\d+)$/)?.[1];
  const port = explicitPort ? Number(explicitPort) : (url.port ? Number(url.port) : 4416);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('YOUTUBE_DL_POT_PROVIDER_URL must use a port between 1024 and 65535.');
  }

  const host = url.hostname === '[::1]' ? '::1' : '127.0.0.1';
  return {
    enabled,
    baseUrl: host === '::1' ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`,
    host,
    port
  };
}

export function resolveYtDlpPotProviderUrl(providerUrl = process.env.YOUTUBE_DL_POT_PROVIDER_URL) {
  return resolveYtDlpPotProviderConfig({ providerUrl }).baseUrl;
}

function safeProcessError(error) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_-]{1,32}$/i.test(error.code)) {
    return ` (${error.code})`;
  }
  return '';
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 1_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

export async function startYtDlpPotProvider({
  env = process.env,
  spawnImpl = spawn,
  fetchImpl = fetch,
  providerScriptPath = BGUTIL_PROVIDER_SERVER,
  timeoutMs = DEFAULT_YT_DLP_POT_PROVIDER_START_TIMEOUT_MS,
  pollIntervalMs = 100
} = {}) {
  const config = resolveYtDlpPotProviderConfig({ env });
  if (!config.enabled) return { started: false, stop: async () => {} };

  let child;
  try {
    child = spawnImpl(process.execPath, [
      providerScriptPath,
      '--host',
      config.host,
      '--port',
      String(config.port)
    ], {
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (error) {
    throw new Error(`The local YouTube PO-token provider could not start${safeProcessError(error)}.`);
  }

  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const readyUrl = `${config.baseUrl}/ping`;
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`The local YouTube PO-token provider could not start${safeProcessError(spawnError)}.`);
      }
      if (child.exitCode !== null) {
        throw new Error('The local YouTube PO-token provider exited before becoming ready.');
      }
      try {
        const response = await fetchImpl(readyUrl, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          const status = await response.json();
          if (status.version === BGUTIL_PROVIDER_VERSION) {
            child.once('error', () => {});
            return { started: true, stop: () => stopChild(child), child };
          }
          if (status.version) {
            throw new Error('The local YouTube PO-token provider has an incompatible version.');
          }
        }
      } catch (error) {
        if (error.message === 'The local YouTube PO-token provider has an incompatible version.') throw error;
      }
      await delay(pollIntervalMs);
    }
    throw new Error(`The local YouTube PO-token provider did not become ready within ${timeoutMs}ms.`);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

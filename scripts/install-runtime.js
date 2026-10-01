#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { installYtDlp } from './install-yt-dlp.js';
import { installBgutilPotProvider } from './install-bgutil-pot-provider.js';

export async function installRuntime() {
  const ytDlp = await installYtDlp();
  if (['download-failed', 'verify-failed'].includes(ytDlp.outcome)) {
    throw new Error('yt-dlp installation failed; see the installer output above.');
  }
  await installBgutilPotProvider();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installRuntime().catch((error) => {
    console.error(`[install-runtime] ${error.message}`);
    process.exitCode = 1;
  });
}

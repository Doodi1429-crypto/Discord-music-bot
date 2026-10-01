import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, computed relative to this file (src/resolvers/) rather than
 * process.cwd(), so path resolution is correct regardless of the working directory
 * the bot (or its install script) happens to be started from.
 */
export const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Default local directory where scripts/install-yt-dlp.js places an automatically
 * downloaded yt-dlp binary during `npm install` (e.g. on Render's build step). Kept
 * out of PATH/system directories so it never collides with an operator-managed
 * install, and gitignored so the binary itself is never committed.
 */
export const YT_DLP_BIN_DIR = join(REPO_ROOT, 'bin');

/** Platform-appropriate filename for the auto-installed binary. */
export const YT_DLP_BIN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

/** Full default path checked by the resolver when no explicit YOUTUBE_DL_PATH is set. */
export const YT_DLP_DEFAULT_PATH = join(YT_DLP_BIN_DIR, YT_DLP_BIN_NAME);

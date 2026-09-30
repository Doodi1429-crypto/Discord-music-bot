import { execFile } from 'node:child_process';
import { constants, accessSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { UserInputError, AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const YOUTUBE_SEARCH_PREFIX = 'ytsearch1:';
const MAX_ERROR_DETAILS_LENGTH = 1200;

export function resolveYtDlpPath(
  binaryPath = process.env.YOUTUBE_DL_PATH,
  { pathValue = process.env.PATH, access = canExecute } = {}
) {
  if (binaryPath?.trim()) return binaryPath.trim();

  for (const directory of (pathValue || '').split(delimiter).filter(Boolean)) {
    for (const executable of ['yt-dlp', 'youtube-dl']) {
      const candidate = join(directory, executable);
      if (access(candidate)) return candidate;
    }
  }

  return null;
}

function canExecute(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runYtDlp(binaryPath, args, { timeout }) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        parseError.message = `yt-dlp returned invalid JSON: ${parseError.message}`;
        reject(parseError);
      }
    });
  });
}

function errorDetails(error) {
  const details = error.stderr?.trim() || error.message || String(error);
  if (details === 'Error') {
    return 'yt-dlp failed without diagnostic output. Verify the yt-dlp binary and network access.';
  }
  return details.slice(0, MAX_ERROR_DETAILS_LENGTH);
}

export class YouTubeResolver {
  constructor({ timeout = 30_000, binaryPath = process.env.YOUTUBE_DL_PATH, runner = runYtDlp } = {}) {
    this.timeout = timeout;
    this.binaryPath = binaryPath || null;
    this.runner = runner;
  }

  async resolveVideoId(videoId) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new UserInputError('Invalid YouTube video ID.');
    }
    return this.resolveVideoUrl(`https://www.youtube.com/watch?v=${videoId}`);
  }

  async resolveVideoUrl(url) {
    try {
      const info = await this.getInfo(url);
      const audioUrl = info.requested_downloads?.find((item) => item.url)?.url
        || (info.acodec && info.acodec !== 'none' ? info.url : null)
        || info.formats?.find((format) => format.acodec && format.acodec !== 'none' && format.url)?.url;

      if (!audioUrl) {
        throw new AudioSourceError('Could not extract a playable audio stream from this YouTube video.');
      }

      return {
        url: audioUrl,
        title: info.title || 'YouTube Video',
        duration: info.duration ?? null,
        source: 'youtube'
      };
    } catch (error) {
      if (error instanceof UserInputError || error instanceof AudioSourceError) throw error;

      const details = errorDetails(error);
      logger.error('YouTube video resolution failed', { message: details });
      if (/private|unavailable|removed|not available|geo.?restricted/i.test(details)) {
        throw new UserInputError('This YouTube video is unavailable, private, or region-restricted.');
      }
      if (error.code === 'ENOENT') {
        throw new AudioSourceError('yt-dlp executable was not found on PATH. Install yt-dlp or set YOUTUBE_DL_PATH to its executable.');
      }
      throw new AudioSourceError(`Failed to resolve YouTube video: ${details}`);
    }
  }

  async search(query) {
    const normalizedQuery = query?.trim();
    if (!normalizedQuery || normalizedQuery.length < 2) {
      throw new UserInputError('Please provide a search query with at least 2 characters.');
    }
    if (normalizedQuery.length > 200) {
      throw new UserInputError('Search query is too long (maximum 200 characters).');
    }

    try {
      const results = await this.getInfo(`${YOUTUBE_SEARCH_PREFIX}${normalizedQuery}`, { noPlaylist: false });
      const firstResult = results.entries?.find((entry) => entry && (entry.id || entry.url || entry.webpage_url));
      if (!firstResult) throw new UserInputError(`No YouTube results found for: "${normalizedQuery}"`);

      const videoUrl = firstResult.webpage_url
        || (firstResult.id ? `https://www.youtube.com/watch?v=${firstResult.id}` : firstResult.url);
      if (!videoUrl) throw new UserInputError(`No playable YouTube results found for: "${normalizedQuery}"`);
      return await this.resolveVideoUrl(videoUrl);
    } catch (error) {
      if (error instanceof UserInputError || error instanceof AudioSourceError) throw error;
      const details = errorDetails(error);
      logger.error('YouTube search failed', { query: normalizedQuery, message: details });
      throw new AudioSourceError(`Failed to search YouTube for "${normalizedQuery}": ${details}`);
    }
  }

  async getInfo(url, extraFlags = {}) {
    const binaryPath = resolveYtDlpPath(this.binaryPath);
    if (!binaryPath) {
      throw new AudioSourceError('yt-dlp executable was not found on PATH. Install yt-dlp or set YOUTUBE_DL_PATH to its executable.');
    }

    const args = ['--dump-single-json', '--no-warnings', '--format', 'bestaudio/best'];
    if (extraFlags.noPlaylist !== false) args.push('--no-playlist');
    args.push(url);
    return this.runner(binaryPath, args, { timeout: this.timeout });
  }
}

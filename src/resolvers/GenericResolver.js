import { UserInputError, AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  resolveYtDlpPath,
  runYtDlp,
  errorDetails,
  fullErrorDetails
} from './YouTubeResolver.js';

/**
 * Resolves non-YouTube HTTP(S) URLs to playable audio streams using yt-dlp's own
 * extractor support (e.g. SoundCloud, Bandcamp, Vimeo, and any other site yt-dlp
 * recognizes), instead of assuming an arbitrary webpage URL is directly playable.
 *
 * Deliberately does NOT use any YouTube-specific PO-token/bgutil-provider/player-client
 * configuration, cookies, browser auth, or proxies - those remain isolated to
 * YouTubeResolver. This resolver only reuses the generic (non-YouTube-specific)
 * yt-dlp binary-resolution and diagnostic helpers exported by YouTubeResolver.js.
 */
export class GenericResolver {
  constructor({
    ytDlpBinaryPath = process.env.YOUTUBE_DL_PATH,
    ytDlpRunner = runYtDlp,
    ytDlpTimeout = 30_000,
    resolveYtDlpBinary = resolveYtDlpPath
  } = {}) {
    this.ytDlpBinaryPath = ytDlpBinaryPath || null;
    this.ytDlpRunner = ytDlpRunner;
    this.ytDlpTimeout = ytDlpTimeout;
    this.resolveYtDlpBinary = resolveYtDlpBinary;
  }

  async resolve(url) {
    const binaryPath = this.resolveYtDlpBinary(this.ytDlpBinaryPath);
    if (!binaryPath) {
      throw new AudioSourceError(
        'This link requires yt-dlp to extract playable audio, and no yt-dlp binary is available on this server. Only YouTube links/search are supported right now.'
      );
    }

    let info;
    try {
      info = await this.getYtDlpInfo(url, binaryPath);
    } catch (error) {
      if (error instanceof UserInputError || error instanceof AudioSourceError) throw error;

      // Full verbose yt-dlp diagnostics go to Render logs only; Discord only ever
      // receives the short sanitized summary built below.
      const fullDetails = fullErrorDetails(error);
      logger.error('yt-dlp generic resolution failed', { url: safeHostname(url), message: fullDetails });
      const details = errorDetails(error);
      throw new AudioSourceError(`Failed to extract playable audio from this link: ${details}`);
    }

    const audioUrl = info.requested_downloads?.find((item) => item.url)?.url
      || (info.acodec && info.acodec !== 'none' ? info.url : null)
      || info.formats?.find((format) => format.acodec && format.acodec !== 'none' && format.url)?.url;

    if (!audioUrl) {
      throw new AudioSourceError('Could not extract a playable audio stream from this link.');
    }

    return {
      url: audioUrl,
      title: info.title || safeHostname(url) || 'Media',
      duration: info.duration ?? null,
      source: 'generic'
    };
  }

  async getYtDlpInfo(url, binaryPath) {
    const args = ['--dump-single-json', '--no-warnings', '--no-playlist', '--format', 'bestaudio/best', url];
    return this.ytDlpRunner(binaryPath, args, { timeout: this.ytDlpTimeout });
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

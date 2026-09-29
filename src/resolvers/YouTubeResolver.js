import youtubedl, { create as createYoutubeDl } from 'youtube-dl-exec';
import { UserInputError, AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const YOUTUBE_SEARCH_PREFIX = 'ytsearch1:';

export class YouTubeResolver {
  constructor({ timeout = 30_000, binaryPath = process.env.YOUTUBE_DL_PATH } = {}) {
    this.timeout = timeout;
    this.binaryPath = binaryPath || null;
    // youtube-dl-exec ships its own yt-dlp binary via a postinstall download. Hosts that block
    // install scripts or outbound network access (e.g. some restricted Node.js hosting
    // providers) never get that binary even though the package resolves fine. Allow pointing at
    // a system-installed yt-dlp/youtube-dl via YOUTUBE_DL_PATH in that case.
    this.youtubedl = this.binaryPath ? createYoutubeDl(this.binaryPath) : youtubedl;
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

      const message = error.stderr || error.message || String(error);
      logger.error('YouTube video resolution failed', { message });
      if (/private|unavailable|removed|not available|geo.?restricted/i.test(message)) {
        throw new UserInputError('This YouTube video is unavailable, private, or region-restricted.');
      }
      if (/enoent/i.test(message)) {
        throw new AudioSourceError('yt-dlp executable was not found. Set YOUTUBE_DL_PATH to an installed yt-dlp/youtube-dl binary.');
      }
      throw new AudioSourceError('Failed to resolve YouTube video. Please try another video.');
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
      logger.error('YouTube search failed', { query: normalizedQuery, message: error.message });
      throw new AudioSourceError(`Failed to search YouTube for: "${normalizedQuery}"`);
    }
  }

  async getInfo(url, extraFlags = {}) {
    return this.youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      format: 'bestaudio/best',
      ...extraFlags
    }, {
      timeout: this.timeout,
      killSignal: 'SIGKILL'
    });
  }
}

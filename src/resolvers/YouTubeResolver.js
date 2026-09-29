import ytDlp from 'yt-dlp-exec';
import { UserInputError, AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { isValidVideoId } from './urlUtils.js';

const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best';

function mapError(error) {
  const message = `${error.stderr || ''} ${error.message || error}`.toLowerCase();
  if (message.includes('timed out')) {
    return new AudioSourceError('YouTube took too long to respond. Please try again.');
  }
  if (message.includes('private') || message.includes('unavailable') || message.includes('not available')) {
    return new UserInputError('This YouTube video is unavailable (it may be private, deleted, or region-locked).');
  }
  if (message.includes('format') || message.includes('no suitable formats')) {
    return new UserInputError('No playable audio is available for this YouTube video.');
  }
  if (message.includes('yt-dlp') && (message.includes('enoent') || message.includes('not found'))) {
    return new AudioSourceError('YouTube playback is unavailable because yt-dlp could not be started.');
  }
  return new AudioSourceError('Failed to resolve YouTube audio. Please try another video.');
}

export class YouTubeResolver {
  constructor({
    timeout = 30_000,
    execute = ytDlp,
    fallbackExecute = ytDlp.create(process.env.YT_DLP_PATH || 'yt-dlp')
  } = {}) {
    this.timeout = timeout;
    this.execute = execute;
    this.fallbackExecute = fallbackExecute;
  }

  async run(url, options) {
    const executionOptions = {
      timeout: this.timeout,
      maxBuffer: 5 * 1024 * 1024
    };
    let info;
    try {
      info = await this.execute(url, options, executionOptions);
    } catch (error) {
      const message = String(error?.message || error);
      if (error?.code !== 'ENOENT' && !message.includes('ENOENT')) {
        if (error instanceof UserInputError || error instanceof AudioSourceError) throw error;
        throw mapError(error);
      }
      try {
        info = await this.fallbackExecute(url, options, executionOptions);
      } catch (fallbackError) {
        throw mapError(fallbackError);
      }
    }
    if (!info || typeof info !== 'object') throw new AudioSourceError('Could not read YouTube video information.');
    return info;
  }

  async resolveVideoId(videoId) {
    if (!isValidVideoId(videoId)) throw new UserInputError('Invalid YouTube video ID.');

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await this.run(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      format: AUDIO_FORMAT
    });
    const audioUrl = info.requested_downloads?.[0]?.url || info.url;
    if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
      throw new AudioSourceError('Could not extract audio from this YouTube video.');
    }

    return {
      url: audioUrl,
      title: info.title || 'YouTube Video',
      duration: Number.isFinite(info.duration) ? info.duration : null,
      headers: info.http_headers || {},
      source: 'youtube'
    };
  }

  async search(query) {
    if (typeof query !== 'string' || query.trim().length < 2) {
      throw new UserInputError('Please provide a search query with at least 2 characters.');
    }
    if (query.length > 200) throw new UserInputError('Search query is too long (max 200 characters).');

    const info = await this.run(`ytsearch1:${query.trim()}`, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
      flatPlaylist: true
    });
    const videoId = info.entries?.[0]?.id;
    if (!isValidVideoId(videoId)) throw new UserInputError(`No YouTube results found for: "${query.trim()}"`);
    return this.resolveVideoId(videoId);
  }
}

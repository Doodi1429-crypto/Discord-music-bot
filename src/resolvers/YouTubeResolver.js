import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { UserInputError, AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const execPromise = promisify(exec);

/**
 * YouTube resolver using yt-dlp (maintained alternative to youtube-dl)
 * Handles video resolution and search via command-line execution
 */
export class YouTubeResolver {
  constructor() {
    this.ytDlpPath = 'yt-dlp';
    this.timeout = 30000; // 30 second timeout for yt-dlp operations
  }

  /**
   * Resolve a YouTube video ID to a playable audio URL
   */
  async resolveVideoId(videoId) {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    try {
      const audioUrl = await this.extractAudioUrl(youtubeUrl);
      if (!audioUrl) {
        throw new AudioSourceError('Could not extract audio from this YouTube video.');
      }

      // Fetch video title
      const title = await this.getVideoTitle(youtubeUrl);

      return {
        url: audioUrl,
        title: title || 'YouTube Video',
        duration: null,
        source: 'youtube'
      };
    } catch (error) {
      if (error instanceof UserInputError || error instanceof AudioSourceError) {
        throw error;
      }

      const message = error.message || String(error);
      if (message.includes('unavailable') || message.includes('not found')) {
        throw new UserInputError('This YouTube video is unavailable (may be deleted, private, or region-locked).');
      }
      if (message.includes('format') || message.includes('no formats')) {
        throw new UserInputError('No audio formats available for this video.');
      }

      logger.error('YouTube video resolution failed', { videoId, message });
      throw new AudioSourceError('Failed to resolve YouTube video. It may be unavailable.');
    }
  }

  /**
   * Search YouTube for a query and return first result
   */
  async search(query) {
    if (!query || query.trim().length < 2) {
      throw new UserInputError('Please provide a search query with at least 2 characters.');
    }

    if (query.length > 200) {
      throw new UserInputError('Search query is too long (max 200 characters).');
    }

    try {
      const videoId = await this.searchYouTube(query);
      if (!videoId) {
        throw new UserInputError(`No YouTube results found for: "${query}"`);
      }

      // Now resolve the found video to get audio URL
      return await this.resolveVideoId(videoId);
    } catch (error) {
      if (error instanceof UserInputError || error instanceof AudioSourceError) {
        throw error;
      }

      logger.error('YouTube search failed', { query, message: error.message });
      throw new AudioSourceError(`Failed to search YouTube for: "${query}"`);
    }
  }

  /**
   * Extract direct audio URL from YouTube using yt-dlp
   * Returns best available audio stream URL
   */
  async extractAudioUrl(youtubeUrl) {
    const format = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best';
    const command = [
      this.ytDlpPath,
      '--quiet',
      '--no-warnings',
      '-f',
      format,
      '-g', // Get direct URL only (no download)
      youtubeUrl
    ].join(' ');

    try {
      const { stdout } = await this.executeWithTimeout(command);
      const url = stdout.trim().split('\n')[0];
      if (!url || !url.startsWith('http')) {
        return null;
      }
      return url;
    } catch (error) {
      const stderr = error.stderr || error.message;
      if (stderr.includes('unavailable')) {
        throw new UserInputError('This video is unavailable.');
      }
      if (stderr.includes('PrivateVideo')) {
        throw new UserInputError('This is a private video.');
      }
      if (stderr.includes('VideoRemoved')) {
        throw new UserInputError('This video has been removed.');
      }
      throw error;
    }
  }

  /**
   * Get video title from YouTube
   */
  async getVideoTitle(youtubeUrl) {
    const command = [
      this.ytDlpPath,
      '--quiet',
      '--no-warnings',
      '-e', // Get title only
      youtubeUrl
    ].join(' ');

    try {
      const { stdout } = await this.executeWithTimeout(command);
      return stdout.trim() || null;
    } catch {
      return null; // Fail gracefully, use default title
    }
  }

  /**
   * Search YouTube for a query and return first video ID
   */
  async searchYouTube(query) {
    const searchUrl = `ytsearch1:${query}`;
    const command = [
      this.ytDlpPath,
      '--quiet',
      '--no-warnings',
      '--skip-download',
      '-e', // Get title only
      '-o',
      '%(id)s', // Output video ID
      searchUrl
    ].join(' ');

    try {
      const { stdout } = await this.executeWithTimeout(command);
      const videoId = stdout.trim();
      return videoId || null;
    } catch (error) {
      logger.warn('YouTube search error', { query, message: error.message });
      return null;
    }
  }

  /**
   * Execute command with timeout protection
   */
  async executeWithTimeout(command) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('yt-dlp command timed out'));
      }, this.timeout);

      execPromise(command)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
}

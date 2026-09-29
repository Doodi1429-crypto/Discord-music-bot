import { isValidUrl, isYouTubeUrl, extractVideoId } from './urlUtils.js';
import { YouTubeResolver } from './YouTubeResolver.js';
import { logger } from '../utils/logger.js';
import { UserInputError } from '../utils/errors.js';

export class SourceResolver {
  constructor() {
    this.youtubeResolver = new YouTubeResolver();
  }

  /**
   * Resolve a user input (URL or search query) to a playable source.
   * Supports:
   * - Direct audio/video URLs (http(s)://...)
   * - YouTube video URLs (youtube.com/watch?v=...)
   * - YouTube short URLs (youtu.be/...)
   * - YouTube search queries (text input without http://)
   *
   * Returns: { url, title, duration, source } where source is the resolver used
   */
  async resolve(input) {
    if (!input || typeof input !== 'string') {
      throw new UserInputError('Please provide a valid URL or search query.');
    }

    input = input.trim();
    if (!input) {
      throw new UserInputError('Please provide a valid URL or search query.');
    }

    // Check if it's a URL
    if (isValidUrl(input)) {
      // YouTube URL detected
      if (isYouTubeUrl(input)) {
        const videoId = extractVideoId(input);
        if (!videoId) {
          throw new UserInputError('Invalid YouTube URL format.');
        }
        return await this.youtubeResolver.resolveVideoId(videoId);
      }

      // Direct media URL (HTTP/HTTPS)
      return {
        url: input,
        title: new URL(input).hostname || 'Direct Media',
        duration: null,
        source: 'direct'
      };
    }

    // Not a URL - treat as search query
    return await this.youtubeResolver.search(input);
  }
}

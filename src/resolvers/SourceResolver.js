import { isValidUrl, isYouTubeUrl, extractVideoId } from './urlUtils.js';
import { YouTubeResolver } from './YouTubeResolver.js';
import { GenericResolver } from './GenericResolver.js';
import { UserInputError } from '../utils/errors.js';

export class SourceResolver {
  constructor({ youtubeResolver, genericResolver } = {}) {
    this.youtubeResolver = youtubeResolver || new YouTubeResolver();
    this.genericResolver = genericResolver || new GenericResolver();
  }

  /**
   * Resolve a user input (URL or search query) to a playable source.
   * Supports:
   * - YouTube video URLs (youtube.com/watch?v=...) and short URLs (youtu.be/...),
   *   resolved via youtubei.js with an optional yt-dlp (PO-token/bgutil-aware) fallback.
   * - Other HTTP(S) URLs from any site yt-dlp supports (e.g. SoundCloud, Bandcamp,
   *   Vimeo), resolved via yt-dlp's generic extractor support. YouTube-specific
   *   PO-token/bgutil/player-client configuration never applies to these. A clean
   *   user-facing error is returned when extraction does not yield playable audio
   *   (e.g. the link requires auth, is a non-media webpage, or isn't supported).
   * - Text search queries, which only search YouTube today; there is no search
   *   mechanism wired up for other platforms, so non-URL input never reaches
   *   GenericResolver.
   *
   * A failure resolving one URL/platform never affects resolution of another: YouTube
   * and non-YouTube URLs are handled by entirely separate resolver instances.
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

      // Non-YouTube HTTP(S) URL - verify it actually yields playable audio via
      // yt-dlp's generic extractor support rather than assuming any webpage URL
      // is directly playable.
      return await this.genericResolver.resolve(input);
    }

    // Not a URL - treat as a YouTube search query (the only search mechanism wired up).
    return await this.youtubeResolver.search(input);
  }
}

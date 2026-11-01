import { isValidUrl, isYouTubeUrl, isSoundCloudUrl, extractVideoId, extractPlaylistId, assertPublicUrl } from './urlUtils.js';
import { SoundCloudResolver, MAX_PLAYLIST_TRACKS, isSoundCloudPlaylistUrl } from './SoundCloudResolver.js';
import { resolveYtDlpPath } from './YouTubeResolver.js';
import { YouTubeResolver } from './YouTubeResolver.js';
import { GenericResolver } from './GenericResolver.js';
import { UserInputError, AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { errorDetails, fullErrorDetails } from './YouTubeResolver.js';

export class SourceResolver {
  constructor({ youtubeResolver, genericResolver, soundcloudResolver, assertUrl = assertPublicUrl, resolveYtDlpBinary = resolveYtDlpPath } = {}) {
    this.youtubeResolver = youtubeResolver || new YouTubeResolver();
    this.genericResolver = genericResolver || new GenericResolver();
    this.soundcloudResolver = soundcloudResolver || new SoundCloudResolver();
    this.assertUrl = assertUrl;
    this.resolveYtDlpBinary = resolveYtDlpBinary;
  }

  /**
   * Resolve input into one or more tracks. `source` is 'auto' | 'youtube' | 'soundcloud' and only
   * affects text searches. Playlists are capped at MAX_PLAYLIST_TRACKS and resolved lazily.
   * Returns { tracks, playlistTitle|null }.
   */
  async resolveMany(input, { source = 'auto' } = {}) {
    const text = typeof input === 'string' ? input.trim() : '';
    if (!text) throw new UserInputError('Please provide a valid URL or search query.');

    if (isValidUrl(text)) {
      await this.assertUrl(text, { ErrorType: UserInputError });
      if (isSoundCloudUrl(text) && isSoundCloudPlaylistUrl(text)) {
        const playlist = await this.soundcloudResolver.resolvePlaylist(text, MAX_PLAYLIST_TRACKS);
        return { tracks: playlist.tracks, playlistTitle: playlist.title };
      }
      const playlistId = isYouTubeUrl(text) ? extractPlaylistId(text) : null;
      if (playlistId) return this.resolveYouTubePlaylist(text);
    }
    return { tracks: [await this.resolve(text, { source })], playlistTitle: null };
  }

  async resolveYouTubePlaylist(url) {
    const binary = this.resolveYtDlpBinary(process.env.YOUTUBE_DL_PATH);
    if (!binary) throw new AudioSourceError('قوائم يوتيوب تحتاج yt-dlp وهو غير متوفر على هذا الخادم.');
    let info;
    try {
      info = await this.youtubeResolver.getYtDlpInfo(url, binary, { noPlaylist: false, playlistEnd: MAX_PLAYLIST_TRACKS });
    } catch (error) {
      logger.error('YouTube playlist extraction failed', { message: fullErrorDetails(error) });
      throw new AudioSourceError(`تعذّر قراءة قائمة يوتيوب: ${errorDetails(error)}`);
    }
    const entries = (info.entries || []).filter((e) => e?.id).slice(0, MAX_PLAYLIST_TRACKS);
    if (!entries.length) throw new UserInputError('قائمة التشغيل فارغة أو غير متاحة.');
    return {
      playlistTitle: info.title || 'YouTube',
      tracks: entries.map((e) => ({
        url: null,
        pageUrl: `https://www.youtube.com/watch?v=${e.id}`,
        title: e.title || 'YouTube',
        duration: e.duration ?? null,
        source: 'youtube',
        thumbnail: null
      }))
    };
  }

  /** Make sure a queued track has a fresh stream URL (lazy playlist entries and expired links). */
  async ensureStream(track) {
    if (track.url && !track.stale) return track;
    if (!track.pageUrl) throw new AudioSourceError('لا يوجد رابط لهذا المسار.');
    const fresh = await this.resolve(track.pageUrl);
    return Object.assign(track, { url: fresh.url, duration: track.duration ?? fresh.duration, thumbnail: track.thumbnail ?? fresh.thumbnail, stale: false });
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
  async resolve(input, { source = 'auto' } = {}) {
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

      await this.assertUrl(input, { ErrorType: UserInputError });

      if (isSoundCloudUrl(input)) return await this.soundcloudResolver.resolve(input);

      // Non-YouTube HTTP(S) URL - verify it actually yields playable audio via
      // yt-dlp's generic extractor support rather than assuming any webpage URL
      // is directly playable.
      return await this.genericResolver.resolve(input);
    }

    if (source === 'soundcloud') return await this.soundcloudResolver.search(input);
    if (source === 'youtube') return await this.youtubeResolver.search(input);

    // 'auto': YouTube first, SoundCloud as the alternative when YouTube is failing.
    try {
      return await this.youtubeResolver.search(input);
    } catch (youtubeError) {
      if (youtubeError instanceof UserInputError) throw youtubeError;
      logger.warn('YouTube search failed, trying SoundCloud', { message: youtubeError.message });
      try {
        return await this.soundcloudResolver.search(input);
      } catch (soundcloudError) {
        logger.warn('SoundCloud search fallback failed', { message: soundcloudError.message });
        throw youtubeError;
      }
    }
  }
}

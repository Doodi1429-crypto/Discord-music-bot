import { UserInputError, AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { assertPublicUrl } from './urlUtils.js';
import { resolveYtDlpPath, runYtDlp, errorDetails, fullErrorDetails } from './YouTubeResolver.js';

export const MAX_PLAYLIST_TRACKS = 25;
const UNAVAILABLE = /404|not found|private|unavailable|removed|geo|blocked|403|forbidden|unsupported url/i;

export function pickAudioUrl(info) {
  return info?.requested_downloads?.find((item) => item.url)?.url
    || (info?.acodec && info.acodec !== 'none' ? info.url : null)
    || info?.formats?.find((format) => format.acodec && format.acodec !== 'none' && format.url)?.url
    || info?.url
    || null;
}

export function isSoundCloudPlaylistUrl(input) {
  try {
    const { pathname } = new URL(input);
    return /\/sets\/[^/]+/.test(pathname) || /\/(albums|likes|reposts)\/?$/.test(pathname);
  } catch {
    return false;
  }
}

/** SoundCloud search, track and playlist resolution through yt-dlp's SoundCloud extractor. */
export class SoundCloudResolver {
  constructor({
    ytDlpBinaryPath = process.env.YOUTUBE_DL_PATH,
    ytDlpRunner = runYtDlp,
    ytDlpTimeout = 30_000,
    resolveYtDlpBinary = resolveYtDlpPath,
    assertUrl = assertPublicUrl
  } = {}) {
    this.ytDlpBinaryPath = ytDlpBinaryPath || null;
    this.ytDlpRunner = ytDlpRunner;
    this.ytDlpTimeout = ytDlpTimeout;
    this.resolveYtDlpBinary = resolveYtDlpBinary;
    this.assertUrl = assertUrl;
  }

  binary() {
    const binary = this.resolveYtDlpBinary(this.ytDlpBinaryPath);
    if (!binary) throw new AudioSourceError('لا يوجد yt-dlp على هذا الخادم، لذلك SoundCloud غير متاح حالياً.');
    return binary;
  }

  async run(args, context) {
    try {
      return await this.ytDlpRunner(this.binary(), ['--dump-single-json', '--no-warnings', ...args], { timeout: this.ytDlpTimeout });
    } catch (error) {
      if (error instanceof UserInputError || error instanceof AudioSourceError) throw error;
      logger.error('SoundCloud extraction failed', { context, message: fullErrorDetails(error) });
      const details = errorDetails(error);
      if (UNAVAILABLE.test(details)) throw new UserInputError('هذا المسار غير متاح على SoundCloud (محذوف أو خاص أو محظور في المنطقة).');
      throw new AudioSourceError(`تعذّر جلب الصوت من SoundCloud: ${details}`);
    }
  }

  toTrack(info, fallbackUrl) {
    const url = pickAudioUrl(info);
    if (!url) throw new AudioSourceError('تعذّر استخراج رابط صوتي قابل للتشغيل من SoundCloud.');
    return {
      url,
      title: info.title || 'SoundCloud',
      duration: info.duration ?? null,
      source: 'soundcloud',
      pageUrl: info.webpage_url || fallbackUrl || null,
      thumbnail: info.thumbnail ?? null,
      artist: info.uploader ?? null
    };
  }

  async search(query) {
    const q = query?.trim();
    if (!q || q.length < 2) throw new UserInputError('اكتب كلمة بحث من حرفين على الأقل.');
    if (q.length > 200) throw new UserInputError('نص البحث طويل جداً (الحد 200 حرف).');
    const info = await this.run(['--format', 'bestaudio/best', `scsearch1:${q}`], 'search');
    const entry = info.entries?.find((e) => e && (e.url || e.formats));
    if (!entry) throw new UserInputError(`لا توجد نتائج في SoundCloud لـ "${q}".`);
    return this.toTrack(entry);
  }

  async resolve(url) {
    await this.assertUrl(url, { ErrorType: UserInputError });
    const info = await this.run(['--no-playlist', '--format', 'bestaudio/best', url], 'track');
    return this.toTrack(info, url);
  }

  /** Playlists are returned as lazy tracks (no stream URL yet); streams are resolved right before playback. */
  async resolvePlaylist(url, limit = MAX_PLAYLIST_TRACKS) {
    await this.assertUrl(url, { ErrorType: UserInputError });
    const info = await this.run(['--flat-playlist', '--playlist-end', String(limit), url], 'playlist');
    const entries = (info.entries || []).filter((e) => e?.url).slice(0, limit);
    if (!entries.length) throw new UserInputError('قائمة التشغيل فارغة أو غير متاحة.');
    return {
      title: info.title || 'SoundCloud',
      tracks: entries.map((e) => ({
        url: null,
        pageUrl: e.url,
        title: e.title || 'SoundCloud',
        duration: e.duration ?? null,
        source: 'soundcloud',
        thumbnail: null
      }))
    };
  }
}

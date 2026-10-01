import { execFile } from 'node:child_process';
import { constants, accessSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { extractVideoId, isValidVideoId } from './urlUtils.js';
import { UserInputError, AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { YT_DLP_DEFAULT_PATH } from './ytDlpPaths.js';

const YOUTUBE_SEARCH_PREFIX = 'ytsearch1:';
const MAX_ERROR_DETAILS_LENGTH = 1200;
// Deliberately does NOT match "sign in to confirm" generically: that phrase is also
// used by YouTube's bot-detection challenge (see BOT_CHECK_PATTERN below), which must
// be distinguished from these genuine user-input restrictions (private/age-gated/
// removed/region-restricted videos) and is always checked first at both call sites.
const UNAVAILABLE_PATTERN = /private|unavailable|removed|not available|geo.?restricted|region|age.?restrict|login required/i;
// Matches Innertube's bot-detection challenge (e.g. "Sign in to confirm you're not a
// bot"), as distinct from genuine user-input restrictions matched by UNAVAILABLE_PATTERN
// above. This is an upstream YouTube/IP-reputation challenge rather than a problem with
// the requested video, so it should allow the optional yt-dlp fallback to run instead of
// being rejected outright as user input.
const BOT_CHECK_PATTERN = /not a bot|automated (queries|requests)/i;

/**
 * Lazily creates the default Innertube (youtubei.js) client used to resolve YouTube
 * audio streams without any external executable. youtubei.js speaks YouTube's
 * internal "InnerTube" API directly from Node.js, so no yt-dlp/youtube-dl/Python
 * binary needs to be installed on the host (e.g. WispByte, which only allows
 * additional Node.js packages).
 */
async function createInnertubeClient() {
  const { Innertube } = await import('youtubei.js');
  return Innertube.create({ generate_session_locally: true });
}

/**
 * Resolve an optional yt-dlp/youtube-dl executable, used only as a fallback.
 *
 * Resolution order: an explicit YOUTUBE_DL_PATH override always wins; otherwise the
 * default local path that scripts/install-yt-dlp.js downloads to during `npm install`
 * is checked (making an auto-installed binary discoverable with zero configuration);
 * finally PATH is scanned, covering operator-managed installs (e.g. apt/Docker).
 */
export function resolveYtDlpPath(
  binaryPath = process.env.YOUTUBE_DL_PATH,
  { pathValue = process.env.PATH, access = canExecute, defaultInstallPath = YT_DLP_DEFAULT_PATH } = {}
) {
  if (binaryPath?.trim()) return binaryPath.trim();

  if (defaultInstallPath && access(defaultInstallPath)) return defaultInstallPath;

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

/**
 * Resolves an optional yt-dlp config file path (e.g. `--config-location`), used to let
 * operators supply extractor-args, a PO-token provider plugin configuration, or other
 * yt-dlp settings without embedding them in source. Never logged; path only.
 */
export function resolveYtDlpConfigPath(configPath = process.env.YOUTUBE_DL_CONFIG_PATH) {
  return configPath?.trim() || null;
}

/**
 * Resolves an optional yt-dlp cookies file path (e.g. `--cookies`), used to let operators
 * mount their own exported browser cookies for requests that require authentication.
 * The file contents are never read or logged by this resolver; only the path is passed
 * through to the yt-dlp executable.
 */
export function resolveYtDlpCookiesPath(cookiesPath = process.env.YOUTUBE_DL_COOKIES_PATH) {
  return cookiesPath?.trim() || null;
}

/**
 * Headless-appropriate default player client configuration passed to yt-dlp.
 * Prioritizes `mweb` (recommended by yt-dlp devs in the PO-Token-Guide for headless
 * environments and token provider plugins) with `default` (`visionos,web`) as fallback.
 * Note: YouTube actively subjects datacenter IP ranges (e.g. Render) to bot checks;
 * no tokenless or fixed player client setting universally bypasses bot challenges
 * without operator-provided PO tokens, provider plugins, or cookies.
 */
export const DEFAULT_YT_DLP_PLAYER_CLIENT = 'mweb,default';

/**
 * Resolves operator-configurable player client(s) to pass via `--extractor-args "youtube:player_client=..."`.
 * Defaults to `DEFAULT_YT_DLP_PLAYER_CLIENT`. Setting to empty string or 'none' disables passing player_client.
 */
export function resolveYtDlpPlayerClient(playerClient = process.env.YOUTUBE_DL_PLAYER_CLIENT) {
  if (playerClient === undefined) return DEFAULT_YT_DLP_PLAYER_CLIENT;
  const trimmed = playerClient.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return null;
  return trimmed;
}

/**
 * Resolves an optional operator-configured PO Token string (e.g. `--extractor-args "youtube:po_token=..."`).
 * Sensitive: masked in error diagnostics and logs.
 */
export function resolveYtDlpPoToken(poToken = process.env.YOUTUBE_DL_PO_TOKEN) {
  return poToken?.trim() || null;
}

/**
 * Resolves an optional PO Token provider service URL (e.g. `bgutil-ytdlp-pot-provider`).
 * Passed to yt-dlp via `--extractor-args "youtube:pot-provider=bgutil+..."`.
 */
export function resolveYtDlpPotProviderUrl(providerUrl = process.env.YOUTUBE_DL_POT_PROVIDER_URL) {
  return providerUrl?.trim() || null;
}

/**
 * Resolves optional custom extractor args passed directly to yt-dlp via `--extractor-args`.
 */
export function resolveYtDlpExtractorArgs(extractorArgs = process.env.YOUTUBE_DL_EXTRACTOR_ARGS) {
  return extractorArgs?.trim() || null;
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

/**
 * Sanitizes diagnostic strings before logging or surfacing them in errors, ensuring
 * that any operator-configured PO tokens or extractor-args secrets are not exposed.
 */
export function sanitizeDetails(details, sensitiveValues = []) {
  if (!details || typeof details !== 'string') return '';
  let sanitized = details;
  for (const value of sensitiveValues) {
    if (value && typeof value === 'string' && value.length > 2) {
      sanitized = sanitized.split(value).join('[REDACTED]');
    }
  }
  return sanitized.replace(/(po_token=)[^\s;&"',]+/gi, '$1[REDACTED]');
}

export function errorDetails(error, sensitiveValues = []) {
  const details = error.stderr?.trim() || error.message || String(error);
  if (details === 'Error') {
    return 'yt-dlp failed without diagnostic output. Verify the yt-dlp binary and network access.';
  }
  const sanitized = sanitizeDetails(details, sensitiveValues);
  return sanitized.slice(0, MAX_ERROR_DETAILS_LENGTH);
}

/**
 * Resolves YouTube URLs and search queries to playable audio stream URLs.
 *
 * Primary resolution is done entirely from Node.js using youtubei.js (no external
 * executable required). An optional, explicitly-configured yt-dlp/youtube-dl binary
 * is used only as a fallback when the built-in resolution fails for a reason other
 * than invalid user input - it is never required for the resolver to function.
 */
export class YouTubeResolver {
  constructor({
    createClient = createInnertubeClient,
    ytDlpBinaryPath = process.env.YOUTUBE_DL_PATH,
    ytDlpRunner = runYtDlp,
    ytDlpTimeout = 30_000,
    ytDlpConfigPath = resolveYtDlpConfigPath(),
    ytDlpCookiesPath = resolveYtDlpCookiesPath(),
    ytDlpPlayerClient = resolveYtDlpPlayerClient(),
    ytDlpPoToken = resolveYtDlpPoToken(),
    ytDlpPotProviderUrl = resolveYtDlpPotProviderUrl(),
    ytDlpExtractorArgs = resolveYtDlpExtractorArgs(),
    resolveYtDlpBinary = resolveYtDlpPath
  } = {}) {
    this.createClient = createClient;
    this.ytDlpBinaryPath = ytDlpBinaryPath || null;
    this.ytDlpRunner = ytDlpRunner;
    this.ytDlpTimeout = ytDlpTimeout;
    this.ytDlpConfigPath = ytDlpConfigPath || null;
    this.ytDlpCookiesPath = ytDlpCookiesPath || null;
    this.ytDlpPlayerClient = ytDlpPlayerClient ?? null;
    this.ytDlpPoToken = ytDlpPoToken || null;
    this.ytDlpPotProviderUrl = ytDlpPotProviderUrl || null;
    this.ytDlpExtractorArgs = ytDlpExtractorArgs || null;
    this.resolveYtDlpBinary = resolveYtDlpBinary;
    this.clientPromise = null;
  }

  async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = Promise.resolve(this.createClient()).catch((error) => {
        this.clientPromise = null;
        throw error;
      });
    }
    return this.clientPromise;
  }

  async resolveVideoId(videoId) {
    if (!isValidVideoId(videoId)) {
      throw new UserInputError('Invalid YouTube video ID.');
    }
    return this.resolve(videoId, `https://www.youtube.com/watch?v=${videoId}`);
  }

  async resolveVideoUrl(url) {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new UserInputError('Invalid YouTube URL format.');
    }
    return this.resolve(videoId, url);
  }

  async resolve(videoId, url) {
    try {
      return await this.resolveViaInnertube(videoId);
    } catch (error) {
      if (error instanceof UserInputError) throw error;

      const ytDlpBinary = this.resolveYtDlpBinary(this.ytDlpBinaryPath);
      if (!ytDlpBinary) throw error;

      logger.warn('Built-in YouTube resolution failed, falling back to yt-dlp', { message: error.message });
      return this.resolveViaYtDlp(url, ytDlpBinary);
    }
  }

  async resolveViaInnertube(videoId) {
    const client = await this.getInitializedClient();

    let info;
    try {
      info = await client.getBasicInfo(videoId);
    } catch (error) {
      const message = error?.message || String(error);
      logger.error('YouTube video resolution failed', { message });
      if (BOT_CHECK_PATTERN.test(message)) {
        throw new AudioSourceError(`YouTube requires additional verification for this video: ${message}`);
      }
      if (UNAVAILABLE_PATTERN.test(message)) {
        throw new UserInputError('This YouTube video is unavailable, private, or region-restricted.');
      }
      throw new AudioSourceError(`Failed to resolve YouTube video: ${message}`);
    }

    const status = info.playability_status?.status;
    if (status && status !== 'OK') {
      const reason = info.playability_status?.reason || status;
      if (BOT_CHECK_PATTERN.test(reason)) {
        // Not a user-input problem (the video itself is fine) - let resolve() fall
        // back to yt-dlp (if configured) instead of rejecting the request outright.
        throw new AudioSourceError(`YouTube requires additional verification for this video: ${reason}`);
      }
      throw new UserInputError(`This YouTube video is unavailable: ${reason}`);
    }

    let format = null;
    try {
      format = info.chooseFormat({ type: 'audio', quality: 'best' });
    } catch {
      format = null;
    }
    if (!format) {
      throw new AudioSourceError('Could not extract a playable audio stream from this YouTube video.');
    }

    let audioUrl;
    try {
      audioUrl = await format.decipher(client.session?.player);
    } catch (error) {
      throw new AudioSourceError(`Failed to decode the YouTube audio stream URL: ${error.message || error}`);
    }
    if (!audioUrl) {
      throw new AudioSourceError('Could not extract a playable audio stream from this YouTube video.');
    }

    return {
      url: audioUrl,
      title: info.basic_info?.title || 'YouTube Video',
      duration: info.basic_info?.duration ?? null,
      source: 'youtube'
    };
  }

  async getInitializedClient() {
    try {
      return await this.getClient();
    } catch (error) {
      throw new AudioSourceError(`Failed to initialize the YouTube client: ${error?.message || error}`);
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
      return await this.searchViaInnertube(normalizedQuery);
    } catch (error) {
      if (error instanceof UserInputError) throw error;

      const ytDlpBinary = this.resolveYtDlpBinary(this.ytDlpBinaryPath);
      if (!ytDlpBinary) throw error;

      logger.warn('Built-in YouTube search failed, falling back to yt-dlp', { message: error.message });
      return this.searchViaYtDlp(normalizedQuery, ytDlpBinary);
    }
  }

  async searchViaInnertube(query) {
    const client = await this.getInitializedClient();

    let results;
    try {
      results = await client.search(query, { type: 'video' });
    } catch (error) {
      const message = error?.message || String(error);
      logger.error('YouTube search failed', { query, message });
      throw new AudioSourceError(`Failed to search YouTube for "${query}": ${message}`);
    }

    const firstVideo = results?.videos?.find((video) => video?.video_id || video?.id);
    if (!firstVideo) {
      throw new UserInputError(`No YouTube results found for: "${query}"`);
    }

    return this.resolveViaInnertube(firstVideo.video_id || firstVideo.id);
  }

  // --- Optional yt-dlp fallback (not required; only used when an executable is configured) ---

  buildExtractorArgs() {
    const list = [];
    const customArgsStr = Array.isArray(this.ytDlpExtractorArgs)
      ? this.ytDlpExtractorArgs.join(';')
      : (this.ytDlpExtractorArgs || '');

    const hasClientInCustomArgs = /player[-_]client/i.test(customArgsStr);
    const hasPoTokenInCustomArgs = /po[-_]token/i.test(customArgsStr);
    const hasProviderInCustomArgs = /pot[-_]provider|youtubepot/i.test(customArgsStr);

    if (this.ytDlpPlayerClient && !hasClientInCustomArgs) {
      list.push(`youtube:player_client=${this.ytDlpPlayerClient}`);
    }

    if (this.ytDlpPoToken && !hasPoTokenInCustomArgs) {
      list.push(`youtube:po_token=${this.ytDlpPoToken}`);
    }

    if (this.ytDlpPotProviderUrl && !hasProviderInCustomArgs) {
      const provider = this.ytDlpPotProviderUrl.startsWith('bgutil+')
        ? this.ytDlpPotProviderUrl
        : `bgutil+${this.ytDlpPotProviderUrl}`;
      list.push(`youtube:pot-provider=${provider}`);
    }

    if (this.ytDlpExtractorArgs) {
      if (Array.isArray(this.ytDlpExtractorArgs)) {
        list.push(...this.ytDlpExtractorArgs);
      } else {
        list.push(this.ytDlpExtractorArgs);
      }
    }

    return list;
  }

  getErrorDetails(error) {
    const sensitive = [];
    if (this.ytDlpPoToken) sensitive.push(this.ytDlpPoToken);
    return errorDetails(error, sensitive);
  }

  async resolveViaYtDlp(url, binaryPath) {
    try {
      const info = await this.getYtDlpInfo(url, binaryPath);
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

      const details = this.getErrorDetails(error);
      logger.error('yt-dlp fallback resolution failed', { message: details });
      if (UNAVAILABLE_PATTERN.test(details)) {
        throw new UserInputError('This YouTube video is unavailable, private, or region-restricted.');
      }
      throw new AudioSourceError(`Failed to resolve YouTube video: ${details}`);
    }
  }

  async searchViaYtDlp(query, binaryPath) {
    try {
      const results = await this.getYtDlpInfo(`${YOUTUBE_SEARCH_PREFIX}${query}`, binaryPath, { noPlaylist: false });
      const firstResult = results.entries?.find((entry) => entry && (entry.id || entry.url || entry.webpage_url));
      if (!firstResult) throw new UserInputError(`No YouTube results found for: "${query}"`);

      const videoUrl = firstResult.webpage_url
        || (firstResult.id ? `https://www.youtube.com/watch?v=${firstResult.id}` : firstResult.url);
      if (!videoUrl) throw new UserInputError(`No playable YouTube results found for: "${query}"`);
      return await this.resolveViaYtDlp(videoUrl, binaryPath);
    } catch (error) {
      if (error instanceof UserInputError || error instanceof AudioSourceError) throw error;

      const details = this.getErrorDetails(error);
      logger.error('yt-dlp search fallback failed', { query, message: details });
      throw new AudioSourceError(`Failed to search YouTube for "${query}": ${details}`);
    }
  }

  async getYtDlpInfo(url, binaryPath, extraFlags = {}) {
    const args = ['--dump-single-json', '--no-warnings', '--format', 'bestaudio/best'];
    if (extraFlags.noPlaylist !== false) args.push('--no-playlist');
    // Optional, operator-configured auth/config, passed as discrete argv entries (never
    // through a shell) so a config file and/or cookies file can be supplied without
    // embedding any credentials in source. Omitted entirely when unset, preserving the
    // default invocation used when no such configuration is provided.
    if (this.ytDlpConfigPath) args.push('--config-location', this.ytDlpConfigPath);
    if (this.ytDlpCookiesPath) args.push('--cookies', this.ytDlpCookiesPath);

    for (const extractorArg of this.buildExtractorArgs()) {
      args.push('--extractor-args', extractorArg);
    }

    args.push(url);
    return this.ytDlpRunner(binaryPath, args, { timeout: this.ytDlpTimeout });
  }
}

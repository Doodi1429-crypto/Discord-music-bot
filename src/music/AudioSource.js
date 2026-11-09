import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { assertPublicUrl } from '../resolvers/urlUtils.js';

/**
 * Resolve the ffmpeg executable to use.
 * ffmpeg-static downloads a prebuilt binary via a postinstall script; on hosts that block
 * install scripts or outbound network access (e.g. some restricted Node.js hosting providers)
 * that binary never gets created even though the package resolves. Fall back to an explicit
 * FFMPEG_PATH override or a system-installed `ffmpeg` on PATH in that case.
 */
export function resolveFfmpegPath(ffmpegPath, { staticPath = ffmpegStatic, exists = existsSync } = {}) {
  if (ffmpegPath) return ffmpegPath;
  if (staticPath && exists(staticPath)) return staticPath;
  return 'ffmpeg';
}

/** Loggable description of a stream URL: host and file extension only, never the path or signed query. */
export function describeStreamUrl(url, streamInfo = {}) {
  const extension = /\.([a-z0-9]{2,5})$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
  return {
    host: url.hostname,
    urlProtocol: url.protocol.replace(':', ''),
    urlExtension: extension,
    protocol: streamInfo.protocol ?? null,
    ext: streamInfo.ext ?? null,
    acodec: streamInfo.acodec ?? null,
    abr: streamInfo.abr ?? null
  };
}

/** FFmpeg error text often echoes the input URL; reduce any URL to its origin so signed paths and queries never reach logs. */
export function redactUrls(text) {
  return text.replace(/\b(?:https?|rtmps?|tcp|tls):\/\/[^\s/'"]+[^\s'"]*/gi, (match) => {
    try { return `${new URL(match).origin}/[REDACTED]`; } catch { return '[REDACTED_URL]'; }
  });
}

const FLOW_CHECK_DELAYS_MS = [2000, 5000];

export class AudioSource {
  constructor({ ffmpegPath, assertUrl = assertPublicUrl, flowCheckDelaysMs = FLOW_CHECK_DELAYS_MS } = {}) {
    this.ffmpegPath = resolveFfmpegPath(ffmpegPath);
    this.assertUrl = assertUrl;
    this.flowCheckDelaysMs = flowCheckDelaysMs;
  }

  async create(track, { volume = 1 } = {}) {
    const url = await this.assertUrl(track.url, { ErrorType: AudioSourceError });
    logger.info('Audio stream selected', { title: track.title, source: track.source, ...describeStreamUrl(url, track.streamInfo) });
    const process = spawn(this.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-rw_timeout', '15000000', '-reconnect', '1',
      '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', url.href,
      '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let settled = false;
    const flowTimers = [];
    const cleanup = () => {
      flowTimers.forEach(clearTimeout);
      if (!process.killed) process.kill('SIGKILL');
      process.stdout?.destroy();
      process.stderr?.destroy();
    };
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (text) => logger.warn('FFmpeg', { message: redactUrls(text.trim()).slice(-500) }));
    process.on('close', (code, signal) => {
      logger.info('FFmpeg closed', { title: track.title, code, signal, bytesOut: process.stdout?.bytesRead ?? 0 });
      if (!settled && code && code !== 255) logger.warn('FFmpeg exited before playback ended', { code });
    });

    let spawned = false;
    // spawn() does not throw synchronously when the binary is missing; it emits an async
    // 'error' event instead. Wait for either a successful spawn or that error so a missing
    // ffmpeg binary surfaces as a clear, catchable failure instead of a silently broken track.
    const spawnResult = new Promise((resolve, reject) => {
      process.once('spawn', () => { spawned = true; resolve(); });
      process.on('error', (error) => {
        logger.error('FFmpeg process error', { message: error.message });
        if (!spawned) {
          cleanup();
          reject(error.code === 'ENOENT'
            ? new AudioSourceError(`FFmpeg executable not found ("${this.ffmpegPath}"). Set FFMPEG_PATH to a valid ffmpeg binary.`)
            : new AudioSourceError('Failed to start FFmpeg for playback.'));
        }
      });
    });
    await spawnResult;

    const resource = createAudioResource(process.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(volume);
    resource.process = process;
    // bytesRead is a passive counter on the pipe; unlike a 'data' listener it cannot consume audio.
    for (const delay of this.flowCheckDelaysMs) {
      const timer = setTimeout(() => {
        const bytesOut = process.stdout?.bytesRead ?? 0;
        const payload = { title: track.title, afterMs: delay, bytesOut, playbackMs: resource.playbackDuration ?? null, ffmpegExited: process.exitCode !== null };
        if (bytesOut > 0) logger.info('FFmpeg audio flowing', payload);
        else logger.warn('FFmpeg produced no audio data', payload);
      }, delay);
      timer.unref?.();
      flowTimers.push(timer);
    }
    resource.cleanup = () => {
      settled = true;
      cleanup();
    };
    return resource;
  }
}

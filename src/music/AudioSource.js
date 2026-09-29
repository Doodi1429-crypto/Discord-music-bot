import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const blockedHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function validateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AudioSourceError('Please provide a valid http(s) media URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AudioSourceError('Only http(s) media URLs are supported.');
  if (blockedHosts.has(url.hostname.toLowerCase())) throw new AudioSourceError('Local URLs are not supported.');
  return url;
}

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

export class AudioSource {
  constructor({ ffmpegPath } = {}) {
    this.ffmpegPath = resolveFfmpegPath(ffmpegPath);
  }

  async create(track) {
    const url = validateUrl(track.url);
    const process = spawn(this.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-reconnect', '1',
      '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', url.href,
      '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let settled = false;
    const cleanup = () => {
      if (!process.killed) process.kill('SIGKILL');
      process.stdout?.destroy();
      process.stderr?.destroy();
    };
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (text) => logger.warn('FFmpeg', { message: text.trim().slice(-500) }));
    process.on('close', (code) => {
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

    const resource = createAudioResource(process.stdout, { inputType: StreamType.Raw, inlineVolume: false });
    resource.process = process;
    resource.cleanup = () => {
      settled = true;
      cleanup();
    };
    return resource;
  }
}

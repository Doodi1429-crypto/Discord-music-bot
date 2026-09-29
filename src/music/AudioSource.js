import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegStatic from 'ffmpeg-static';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { AudioSourceError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const blockedHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AudioSourceError('Please provide a valid http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AudioSourceError('Only http(s) URLs are supported.');
  if (blockedHosts.has(url.hostname.toLowerCase())) throw new AudioSourceError('Local URLs are not supported.');
  return url;
}

export class AudioSource {
  constructor({ ffmpegPath, spawnProcess = spawn, requestTimeout = 10_000 } = {}) {
    this.ffmpegPath = ffmpegPath || ffmpegStatic || 'ffmpeg';
    this.spawnProcess = spawnProcess;
    this.requestTimeout = requestTimeout;
  }

  async create(track) {
    const url = validateUrl(track.url);
    if (track.source !== 'youtube') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeout);
      let response;
      try {
        response = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
      } catch (error) {
        controller.abort();
        throw new AudioSourceError(`Could not reach the audio URL: ${error.message}`);
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok && response.status !== 405) throw new AudioSourceError(`The audio URL returned HTTP ${response.status}.`);
      const type = response.headers.get('content-type') || '';
      if (type && !/^(audio|video)\//i.test(type) && !type.includes('octet-stream')) {
        throw new AudioSourceError('This URL is not a direct audio/video file. Video page URLs are not supported.');
      }
    }

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    const headers = Object.entries(track.headers || {})
      .filter(([key, value]) => /^[\w-]+$/.test(key) && typeof value === 'string' && !/[\r\n]/.test(value))
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join('');
    if (headers) args.push('-headers', headers);
    args.push('-i', url.href, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

    const process = this.spawnProcess(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let settled = false;
    const stream = Readable.from(process.stdout);
    const cleanup = () => {
      settled = true;
      if (!process.killed) process.kill('SIGKILL');
      process.stdout?.destroy();
      process.stderr?.destroy();
    };
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (text) => logger.warn('FFmpeg', { message: text.trim().slice(-500) }));
    process.on('error', (error) => {
      if (!settled) stream.destroy(new AudioSourceError(`Unable to start FFmpeg: ${error.message}`));
    });
    process.on('close', (code) => {
      if (!settled && code !== 0) {
        logger.warn('FFmpeg exited before playback ended', { code });
        stream.destroy(new AudioSourceError('The audio stream ended unexpectedly.'));
      }
    });

    const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: false });
    resource.process = process;
    resource.cleanup = cleanup;
    return resource;
  }
}

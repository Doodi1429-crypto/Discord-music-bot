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
  constructor({ ffmpegPath } = {}) { this.ffmpegPath = ffmpegPath || ffmpegStatic || 'ffmpeg'; }

  async create(track) {
    const url = validateUrl(track.url);
    const controller = new AbortController();
    let response;
    try {
      response = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    } catch (error) {
      controller.abort();
      throw new AudioSourceError(`Could not reach the audio URL: ${error.message}`);
    }
    if (!response.ok && response.status !== 405) throw new AudioSourceError(`The audio URL returned HTTP ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    if (type && !/^(audio|video)\//i.test(type) && !type.includes('octet-stream')) {
      throw new AudioSourceError('This URL is not a direct audio/video file. Video page URLs are not supported.');
    }

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
    process.on('error', (error) => { if (!settled) logger.error('FFmpeg process error', { message: error.message }); });
    process.on('close', (code) => {
      if (!settled && code && code !== 255) logger.warn('FFmpeg exited before playback ended', { code });
    });

    const stream = Readable.from(process.stdout);
    stream.on('error', cleanup);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: false });
    resource.process = process;
    resource.cleanup = () => { settled = true; cleanup(); };
    return resource;
  }
}

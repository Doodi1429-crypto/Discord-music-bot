import { spawn } from 'node:child_process';
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

export class AudioSource {
  constructor({ ffmpegPath } = {}) {
    this.ffmpegPath = ffmpegPath || ffmpegStatic || 'ffmpeg';
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
    process.on('error', (error) => logger.error('FFmpeg process error', { message: error.message }));
    process.on('close', (code) => {
      if (!settled && code && code !== 255) logger.warn('FFmpeg exited before playback ended', { code });
    });

    const resource = createAudioResource(process.stdout, { inputType: StreamType.Raw, inlineVolume: false });
    resource.process = process;
    resource.cleanup = () => {
      settled = true;
      cleanup();
    };
    return resource;
  }
}

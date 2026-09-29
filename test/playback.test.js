import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AudioPlayerStatus } from '@discordjs/voice';
import { AudioSource } from '../src/music/AudioSource.js';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { AudioSourceError } from '../src/utils/errors.js';

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function fakePlayer() {
  const player = new EventEmitter();
  player.played = [];
  player.play = (resource) => player.played.push(resource);
  player.stop = () => true;
  player.pause = () => true;
  player.unpause = () => true;
  return player;
}

test('YouTube audio bypasses direct-file HEAD checks and cleans up FFmpeg', async () => {
  const child = fakeProcess();
  const calls = [];
  const source = new AudioSource({
    ffmpegPath: 'ffmpeg-test',
    spawnProcess: (...args) => { calls.push(args); return child; }
  });
  const resource = await source.create({
    url: 'https://media.example/signed-audio',
    source: 'youtube',
    headers: { 'User-Agent': 'test-agent', Referer: 'https://youtube.com/', Injection: 'bad\r\n-i pipe:2' }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'ffmpeg-test');
  assert.equal(calls[0][1][calls[0][1].indexOf('-i') + 1], 'https://media.example/signed-audio');
  assert.equal(calls[0][1][calls[0][1].indexOf('-headers') + 1], 'User-Agent: test-agent\r\nReferer: https://youtube.com/\r\n');
  resource.cleanup();
  assert.equal(child.killed, true);
});

test('direct media is checked before FFmpeg starts', async () => {
  const originalFetch = globalThis.fetch;
  let method;
  globalThis.fetch = async (_url, options) => {
    method = options.method;
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }) };
  };
  const child = fakeProcess();
  try {
    const source = new AudioSource({ spawnProcess: () => child });
    const resource = await source.create({ url: 'https://media.example/song.mp3', source: 'direct' });
    assert.equal(method, 'HEAD');
    resource.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('queue advances after completion and failed startup without leaking resources', async () => {
  let calls = 0;
  let cleanupCount = 0;
  const source = {
    async create() {
      calls += 1;
      if (calls === 1) throw new AudioSourceError('first track failed');
      return { cleanup: () => { cleanupCount += 1; } };
    }
  };
  const player = fakePlayer();
  const guildPlayer = new GuildPlayer({ id: 'guild' }, { source, player });
  const first = { title: 'failed' };
  const second = { title: 'playing' };
  guildPlayer.queue.push(first, second);

  await assert.rejects(guildPlayer.playNext(), /first track failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guildPlayer.current, second);
  assert.equal(player.played.length, 1);
  player.emit(AudioPlayerStatus.Idle);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guildPlayer.current, null);
  assert.equal(cleanupCount, 1);
});

test('player errors clean up the active resource', async () => {
  let cleanupCount = 0;
  const player = fakePlayer();
  const guildPlayer = new GuildPlayer({ id: 'guild' }, {
    player,
    source: { async create() { return { cleanup: () => { cleanupCount += 1; } }; } }
  });
  guildPlayer.queue.push({ title: 'track' });
  await guildPlayer.playNext();
  player.emit('error', new Error('decoder failed'));
  assert.equal(cleanupCount, 1);
  assert.equal(guildPlayer.current, null);
  assert.equal(guildPlayer.resource, null);
});

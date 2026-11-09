import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VoiceConnectionStatus, VoiceConnectionDisconnectReason, NetworkingStatusCode } from '@discordjs/voice';
import { GuildPlayer, describeVoiceState } from '../src/music/GuildPlayer.js';
import { MusicManager } from '../src/music/MusicManager.js';
import { SourceResolver } from '../src/resolvers/SourceResolver.js';
import { SoundCloudResolver, describeAudioSelection } from '../src/resolvers/SoundCloudResolver.js';
import { UserInputError, AudioSourceError } from '../src/utils/errors.js';
import { commands } from '../src/commands/index.js';
import { healthSnapshot, startHeartbeat } from '../src/health.js';

class FakeConnection extends EventEmitter {
  constructor(channelId) {
    super();
    this.joinConfig = { channelId };
    this.state = { status: VoiceConnectionStatus.Signalling };
    this.rejoins = 0;
    this.destroyed = 0;
  }
  setState(state) {
    const old = this.state; this.state = state;
    this.emit('stateChange', old, state);
    this.emit(state.status, old, state);
  }
  subscribe() {}
  rejoin() { this.rejoins += 1; this.setState({ status: VoiceConnectionStatus.Signalling }); return true; }
  destroy() { this.destroyed += 1; if (this.state.status !== VoiceConnectionStatus.Destroyed) this.setState({ status: VoiceConnectionStatus.Destroyed }); }
}

const channel = (id = '1') => ({ id, joinable: true, speakable: true, guild: { id: 'g', voiceAdapterCreator: () => {} } });
const guild = { id: 'g' };
const fastTimings = { readyMs: 50, moveGraceMs: 20, rejoinBaseMs: 1 };

function makePlayer({ autoReady = true, source } = {}) {
  const connections = [];
  const player = new GuildPlayer(guild, { idleLeaveMs: 0 }, {
    audioSource: source ?? { create: async () => ({ cleanup() {}, playbackDuration: 0 }) },
    findConnection: () => undefined,
    timings: fastTimings,
    joinVoice: ({ channelId }) => {
      const c = new FakeConnection(channelId);
      connections.push(c);
      if (autoReady) setTimeout(() => c.setState({ status: VoiceConnectionStatus.Ready }), 1);
      return c;
    }
  });
  player.player.play = () => {};
  return { player, connections };
}
const track = (title, extra = {}) => ({ title, url: `https://cdn.example/${title}.mp3`, source: 'generic', duration: 10, ...extra });

test('concurrent joins create exactly one voice connection', async () => {
  const { player, connections } = makePlayer();
  await Promise.all([player.join(channel()), player.join(channel()), player.join(channel())]);
  assert.equal(connections.length, 1);
});

test('join failure reports the exact cause, destroys the connection and leaves no state behind', async () => {
  const { player, connections } = makePlayer({ autoReady: false });
  await assert.rejects(() => player.join(channel()), (e) => e instanceof UserInputError && /Signalling/.test(e.message));
  assert.equal(connections[0].destroyed, 1);
  assert.equal(player.connection, null);
  const retry = makePlayer();
  await retry.player.join(channel());
});

test('describeVoiceState names UDP, DAVE (4017) and kicked (4014) causes', () => {
  assert.match(describeVoiceState({ status: VoiceConnectionStatus.Connecting, networking: { state: { code: NetworkingStatusCode.UdpHandshaking } } }), /UDP/);
  const closed = (closeCode) => ({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode });
  assert.match(describeVoiceState(closed(4017)), /DAVE/);
  assert.match(describeVoiceState(closed(4014)), /4014/);
});

test('network disconnect triggers rejoin; recovery resets the attempt counter', async () => {
  const { player, connections } = makePlayer();
  await player.join(channel());
  const c = connections[0];
  c.setState({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 1006 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(c.rejoins, 1);
  c.setState({ status: VoiceConnectionStatus.Ready });
  assert.equal(player.rejoinAttempts, 0);
  assert.equal(player.destroyed, false);
});

test('kicked from the channel (4014) tears the player down; exhausted retries do too', async () => {
  const kicked = makePlayer();
  await kicked.player.join(channel());
  kicked.connections[0].setState({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(kicked.player.destroyed, true);

  const flaky = makePlayer();
  await flaky.player.join(channel());
  const c = flaky.connections[0];
  c.rejoin = function rejoin() { this.rejoins += 1; return true; }; // never recovers
  for (let i = 0; i < 6 && !flaky.player.destroyed; i += 1) {
    c.state = { status: VoiceConnectionStatus.Ready };
    c.setState({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 1006 });
    await new Promise((r) => setTimeout(r, 120));
    c.state = { status: VoiceConnectionStatus.Ready };
    flaky.player.rejoinAttempts = Math.max(flaky.player.rejoinAttempts, i + 1);
  }
  assert.equal(flaky.player.destroyed, true);
});

test('queue: next track autoplays; loop track/queue, skip, remove, clear, shuffle, volume', async () => {
  const { player } = makePlayer();
  await player.add([track('a'), track('b'), track('c')], channel());
  assert.equal(player.current.title, 'a');
  assert.deepEqual(player.queue.map((t) => t.title), ['b', 'c']);

  player.finishCurrent();
  await new Promise((r) => setImmediate(r));
  assert.equal(player.current.title, 'b');

  player.setLoop('track');
  player.finishCurrent();
  await new Promise((r) => setImmediate(r));
  assert.equal(player.current.title, 'b');

  player.skip(); // skip must override track-loop
  player.finishCurrent();
  await new Promise((r) => setImmediate(r));
  assert.equal(player.current.title, 'c');

  player.setLoop('queue');
  player.finishCurrent();
  await new Promise((r) => setImmediate(r));
  assert.equal(player.current.title, 'c', 'single-item queue loop replays it');

  player.setLoop('off');
  player.queue = [track('x'), track('y'), track('z')];
  assert.equal(player.remove(2).title, 'y');
  assert.throws(() => player.remove(9), UserInputError);
  player.shuffle();
  assert.equal(player.queue.length, 2);
  assert.equal(player.clear(), 2);
  assert.throws(() => player.shuffle(), UserInputError);
  player.setVolume(80);
  assert.equal(player.volume, 80);
  assert.throws(() => player.setVolume(0), UserInputError);
  assert.throws(() => player.setVolume(101), UserInputError);
});

test('a failing track is skipped and the next one plays; a lone failure is reported to the caller', async () => {
  const source = { create: async (t) => { if (t.title === 'bad') throw new AudioSourceError('boom'); return { cleanup() {} }; } };
  const { player } = makePlayer({ source });
  await player.add([track('bad'), track('good')], channel());
  assert.equal(player.current.title, 'good');

  const lone = makePlayer({ source });
  await assert.rejects(() => lone.player.add([track('bad')], channel()), /boom/);
});

test('lazy playlist tracks are resolved just before playback; queue limit is enforced', async () => {
  const resolver = { ensureStream: async (t) => { t.url = 'https://cdn.example/fresh.mp3'; return t; } };
  const { player } = makePlayer();
  player.resolver = resolver;
  await player.add([{ title: 'lazy', url: null, pageUrl: 'https://soundcloud.com/a/b', source: 'soundcloud' }], channel());
  assert.equal(player.current.url, 'https://cdn.example/fresh.mp3');
  await assert.rejects(() => player.add(Array.from({ length: 101 }, (_, i) => track(`t${i}`)), channel()), /ممتلئ/);
});

test('MusicManager returns one player per guild and replaces destroyed ones', () => {
  const manager = new MusicManager({}, { resolver: {} });
  const g = { id: 'g1' };
  const p1 = manager.get(g);
  assert.equal(manager.get(g), p1);
  p1.destroy();
  assert.notEqual(manager.get(g), p1);
  manager.destroyAll();
});

test('SoundCloudResolver: search, track, playlist cap and unavailable handling (fake yt-dlp)', async () => {
  const calls = [];
  const runner = async (_bin, args) => {
    calls.push(args);
    if (args.includes('scsearch1:lofi')) return { entries: [{ title: 'Lofi', url: 'https://cdn.sndcdn.com/l.mp3', webpage_url: 'https://soundcloud.com/a/lofi', formats: [{ acodec: 'mp3', url: 'https://cdn.sndcdn.com/l.mp3' }] }] };
    if (args.includes('--flat-playlist')) return { title: 'Set', entries: Array.from({ length: 40 }, (_, i) => ({ url: `https://soundcloud.com/a/t${i}`, title: `t${i}` })) };
    if (args.at(-1).includes('gone')) { const e = new Error('x'); e.stderr = 'ERROR: HTTP Error 404: Not Found'; throw e; }
    return { title: 'Track', acodec: 'mp3', url: 'https://cdn.sndcdn.com/t.mp3', webpage_url: 'https://soundcloud.com/a/track' };
  };
  const sc = new SoundCloudResolver({ ytDlpRunner: runner, resolveYtDlpBinary: () => '/yt-dlp', assertUrl: async (u) => new URL(u) });
  assert.equal((await sc.search('lofi')).source, 'soundcloud');
  assert.equal((await sc.resolve('https://soundcloud.com/a/track')).url, 'https://cdn.sndcdn.com/t.mp3');
  const set = await sc.resolvePlaylist('https://soundcloud.com/a/sets/mix');
  assert.equal(set.tracks.length, 25);
  assert.ok(calls.some((a) => a.includes('--playlist-end') && a.includes('25')));
  await assert.rejects(() => sc.resolve('https://soundcloud.com/a/gone'), UserInputError);
  const noBin = new SoundCloudResolver({ resolveYtDlpBinary: () => null });
  await assert.rejects(() => noBin.search('lofi'), AudioSourceError);
});

test('SourceResolver routes SoundCloud, honours the source option and falls back from YouTube', async () => {
  const sc = {
    search: async (q) => ({ title: `sc:${q}`, url: 'https://x/y', source: 'soundcloud' }),
    resolve: async (u) => ({ title: 'sc-url', url: u, source: 'soundcloud' }),
    resolvePlaylist: async () => ({ title: 'Set', tracks: [{ title: 'one', pageUrl: 'https://soundcloud.com/a/1', source: 'soundcloud' }] })
  };
  let ytFails = true;
  const yt = { search: async () => { if (ytFails) throw new AudioSourceError('not a bot'); return { title: 'yt', source: 'youtube' }; }, resolveVideoId: async () => ({ title: 'v', source: 'youtube' }) };
  const r = new SourceResolver({ youtubeResolver: yt, genericResolver: {}, soundcloudResolver: sc, assertUrl: async (u) => new URL(u) });
  assert.equal((await r.resolve('lofi', { source: 'soundcloud' })).source, 'soundcloud');
  assert.equal((await r.resolve('lofi')).title, 'sc:lofi', 'auto falls back to SoundCloud when YouTube fails');
  ytFails = false;
  assert.equal((await r.resolve('lofi')).source, 'youtube');
  assert.equal((await r.resolve('https://soundcloud.com/a/b')).title, 'sc-url');
  const many = await r.resolveMany('https://soundcloud.com/a/sets/x');
  assert.equal(many.playlistTitle, 'Set');
  const strict = new SourceResolver({ youtubeResolver: yt, genericResolver: {}, soundcloudResolver: sc });
  await assert.rejects(() => strict.resolve('http://127.0.0.1:8080/secret'), UserInputError);
  await assert.rejects(() => strict.resolveMany('http://169.254.169.254/latest'), UserInputError);
});

test('all 14 required slash commands (+join, health) are defined with valid, unique JSON bodies', () => {
  const names = commands.map((c) => c.data.name);
  for (const n of ['play', 'pause', 'resume', 'skip', 'stop', 'queue', 'nowplaying', 'leave', 'volume', 'remove', 'clear', 'shuffle', 'loop', 'help']) assert.ok(names.includes(n), n);
  assert.equal(new Set(names).size, names.length);
  for (const c of commands) { const j = c.data.toJSON(); assert.ok(j.description.length <= 100); assert.equal(typeof c.execute, 'function'); }
});

test('heartbeat logs health, and requests a restart after consecutive unhealthy beats', () => {
  const logs = [];
  const logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) };
  const client = { ws: { status: 0, ping: 42 }, guilds: { cache: { size: 1 } } };
  let restarts = 0;
  const hb = startHeartbeat({ client, manager: { players: new Map() }, intervalMs: 1e9, logger, onUnhealthy: () => { restarts += 1; } });
  hb.beat();
  assert.equal(logs.at(-1)[0], 'info');
  client.ws.status = 5;
  hb.beat();
  assert.equal(restarts, 0);
  hb.beat();
  assert.equal(restarts, 1);
  hb.stop();
  assert.equal(healthSnapshot(client, { players: new Map() }).status, 'DISCONNECTED');
});

test('audio player state transitions are logged at info level, with a reason for AutoPaused', () => {
  const { player } = makePlayer();
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    player.player.emit('stateChange', { status: 'playing' }, { status: 'autopaused' });
  } finally { console.log = original; }
  assert.match(lines.join('\n'), /\[INFO\] Audio player state changed.*"to":"autopaused".*no voice connection is subscribed/);
});

test('voice networking state changes and the player subscription are logged at info level', async () => {
  const { player, connections } = makePlayer();
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await player.join(channel());
    const networking = new EventEmitter();
    connections[0].setState({ status: VoiceConnectionStatus.Connecting, networking });
    networking.emit('stateChange', { code: 1 }, { code: 2 });
  } finally { console.log = original; }
  const output = lines.join('\n');
  assert.match(output, /\[INFO\] Audio player subscribed to voice connection/);
  assert.match(output, /\[INFO\] Voice networking state.*"from":1,"to":2/);
});

test('SoundCloud tracks carry non-sensitive stream format info for diagnostics', () => {
  const resolver = new SoundCloudResolver({ ytDlpBinaryPath: 'yt-dlp' });
  const track = resolver.toTrack({ title: 'x', requested_downloads: [{ url: 'https://cdn.example/a?sig=S', protocol: 'm3u8_native', ext: 'mp3', acodec: 'mp3', abr: 128 }] });
  assert.deepEqual(track.streamInfo, { protocol: 'm3u8_native', ext: 'mp3', acodec: 'mp3', abr: 128 });
  assert.equal(track.url, 'https://cdn.example/a?sig=S');
  assert.equal(describeAudioSelection(null), null);
});

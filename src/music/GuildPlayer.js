import {
  AudioPlayerStatus, NetworkingStatusCode, VoiceConnectionDisconnectReason, VoiceConnectionStatus,
  createAudioPlayer, entersState, getVoiceConnection, joinVoiceChannel
} from '@discordjs/voice';
import { AudioSource } from './AudioSource.js';
import { UserInputError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { nowPlayingEmbed, errorEmbed } from '../ui/embeds.js';

export const MAX_QUEUE_SIZE = 100;
export const LOOP_MODES = ['off', 'track', 'queue'];
const READY_TIMEOUT_MS = 20_000;
const MOVE_GRACE_MS = 5_000;
const MAX_REJOIN_ATTEMPTS = 5;
const WS_CLOSE_KICKED = 4014;
const WS_CLOSE_DAVE_REQUIRED = 4017;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Turn a voice connection state into a precise, human-readable failure cause for the logs. */
export function describeVoiceState(state) {
  if (!state) return 'unknown';
  const code = state.networking?.state?.code;
  switch (state.status) {
    case VoiceConnectionStatus.Signalling:
      return 'stuck in Signalling: Discord never sent the voice server/state update (missing GuildVoiceStates intent, no Connect permission, or the gateway shard is not ready)';
    case VoiceConnectionStatus.Connecting:
      if (code === NetworkingStatusCode.OpeningWs) return 'stuck opening the voice WebSocket: outbound WSS to Discord voice is blocked or the endpoint is unreachable';
      if (code === NetworkingStatusCode.Identifying) return 'voice WebSocket opened but Discord did not answer IDENTIFY (invalid session or region problem)';
      if (code === NetworkingStatusCode.UdpHandshaking) return 'UDP handshake/IP discovery timed out: outbound UDP to Discord voice servers is blocked by the host/firewall';
      if (code === NetworkingStatusCode.SelectingProtocol) return 'IP discovery succeeded but protocol selection got no reply (encryption-mode negotiation failed)';
      return `stuck while connecting (networking code: ${code ?? 'n/a'})`;
    case VoiceConnectionStatus.Disconnected:
      if (state.reason === VoiceConnectionDisconnectReason.WebSocketClose) {
        if (state.closeCode === WS_CLOSE_DAVE_REQUIRED) return 'voice gateway closed with 4017: DAVE (E2EE) is required - @discordjs/voice >= 0.19 with @snazzah/davey must be installed';
        if (state.closeCode === WS_CLOSE_KICKED) return 'voice gateway closed with 4014: bot was disconnected, moved, or the channel was deleted';
        return `voice WebSocket closed with code ${state.closeCode}`;
      }
      return `disconnected (${Object.keys(VoiceConnectionDisconnectReason).find((key) => VoiceConnectionDisconnectReason[key] === state.reason) ?? state.reason})`;
    default:
      return state.status;
  }
}

export class GuildPlayer {
  constructor(guild, { ffmpegPath, defaultVolume = 50, idleLeaveMs = 600_000 } = {}, {
    resolver = null, onDestroy = () => {}, audioSource = null,
    joinVoice = joinVoiceChannel, findConnection = getVoiceConnection,
    timings = {}
  } = {}) {
    this.joinVoice = joinVoice;
    this.findConnection = findConnection;
    this.timings = { readyMs: READY_TIMEOUT_MS, moveGraceMs: MOVE_GRACE_MS, rejoinBaseMs: 2_000, ...timings };
    this.guild = guild;
    this.queue = [];
    this.current = null;
    this.connection = null;
    this.resource = null;
    this.player = createAudioPlayer();
    this.source = audioSource || new AudioSource({ ffmpegPath });
    this.resolver = resolver;
    this.onDestroy = onDestroy;
    this.starting = false;
    this.skipping = false;
    this.failing = false;
    this.destroyed = false;
    this.loop = 'off';
    this.volume = Math.min(100, Math.max(1, defaultVolume));
    this.textChannel = null;
    this.joinPromise = null;
    this.rejoinAttempts = 0;
    this.idleLeaveMs = idleLeaveMs;
    this.idleTimer = null;
    this.connectionListeners = new Map();
    this.watchedNetworking = new WeakSet();
    this.player.on('stateChange', (oldState, newState) => {
      const details = { guild: guild.id, from: oldState.status, to: newState.status, track: this.current?.title, voiceStatus: this.connection?.state?.status ?? 'none' };
      if (newState.status === AudioPlayerStatus.AutoPaused) {
        details.reason = 'no voice connection is subscribed or ready, so audio is not being sent';
      }
      if (newState.resource) details.playbackMs = newState.resource.playbackDuration;
      logger.info('Audio player state changed', details);
    });
    this.player.on(AudioPlayerStatus.Idle, () => this.finishCurrent());
    this.player.on('error', (error) => {
      logger.error('Audio player error', { guild: guild.id, track: this.current?.title, message: error.message });
      this.failing = true;
      this.notify({ embeds: [errorEmbed(`فشل تشغيل **${this.current?.title ?? 'المسار'}**: ${error.message}`)] });
    });
  }

  notify(payload) {
    if (!this.textChannel?.send) return;
    Promise.resolve(this.textChannel.send(payload)).catch((error) => logger.warn('Failed to send channel message', { guild: this.guild.id, message: error.message }));
  }

  // ---------------------------------------------------------------- voice

  join(channel) {
    if (this.destroyed) throw new UserInputError('المشغّل أُغلق، جرّب الأمر مرة أخرى.');
    if (!channel?.joinable || !channel.speakable) throw new UserInputError('أحتاج صلاحية الاتصال والتحدث في هذه القناة الصوتية.');
    // Serialise joins so two concurrent commands can never create two connections.
    const run = (this.joinPromise || Promise.resolve()).catch(() => {}).then(() => this.doJoin(channel));
    this.joinPromise = run;
    run.then(() => {}, () => {}).then(() => { if (this.joinPromise === run) this.joinPromise = null; });
    return run;
  }

  async doJoin(channel) {
    const existing = this.findConnection(channel.guild.id) ?? this.connection;
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
      if (existing.joinConfig.channelId === channel.id) {
        if (existing.state.status === VoiceConnectionStatus.Disconnected) existing.rejoin();
        this.attach(existing);
      } else {
        logger.info('Moving to a different voice channel', { guild: this.guild.id, from: existing.joinConfig.channelId, to: channel.id });
        this.detach(existing);
        existing.destroy();
        this.connection = null;
      }
    }
    if (!this.connection) {
      this.attach(this.joinVoice({
        channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true
      }));
    }
    const connection = this.connection;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, this.timings.readyMs);
    } catch {
      const cause = describeVoiceState(connection.state);
      logger.error('Voice connection failed to become ready', { guild: this.guild.id, channel: channel.id, cause });
      this.detach(connection);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      this.connection = null;
      throw new UserInputError(`تعذّر الاتصال بالقناة الصوتية. السبب المحتمل: ${cause}`);
    }
    this.rejoinAttempts = 0;
    this.scheduleIdleCheck();
    return connection;
  }

  attach(connection) {
    if (this.connection === connection) return;
    this.connection = connection;
    const subscription = connection.subscribe(this.player);
    logger.info('Audio player subscribed to voice connection', { guild: this.guild.id, subscribed: Boolean(subscription), voiceStatus: connection.state?.status });
    const listeners = {
      stateChange: (oldState, newState) => {
        logger.info('Voice connection state changed', { guild: this.guild.id, from: oldState.status, to: newState.status });
        if (newState.status === VoiceConnectionStatus.Ready) this.rejoinAttempts = 0;
        this.watchNetworking(newState);
        if (newState.status === VoiceConnectionStatus.Disconnected) void this.handleDisconnect(connection, newState);
        if (newState.status === VoiceConnectionStatus.Destroyed && this.connection === connection) {
          logger.warn('Voice connection destroyed', { guild: this.guild.id });
          this.connection = null;
          this.destroy();
        }
      },
      error: (error) => logger.error('Voice connection error', { guild: this.guild.id, message: error.message }),
      debug: (message) => logger.debug('Voice debug', { guild: this.guild.id, message })
    };
    for (const [event, handler] of Object.entries(listeners)) connection.on(event, handler);
    this.connectionListeners.set(connection, listeners);
    this.watchNetworking(connection.state);
  }

  detach(connection) {
    const listeners = this.connectionListeners.get(connection);
    if (!listeners) return;
    for (const [event, handler] of Object.entries(listeners)) connection.off(event, handler);
    connection.on('error', () => {});
    this.connectionListeners.delete(connection);
  }

  watchNetworking(state) {
    const networking = state.networking;
    if (!networking || this.watchedNetworking.has(networking)) return;
    this.watchedNetworking.add(networking);
    networking.on('stateChange', (oldS, newS) => {
      logger.info('Voice networking state', { guild: this.guild.id, from: oldS.code, to: newS.code });
    });
    networking.on('error', (error) => logger.error('Voice networking error (UDP/WS/encryption)', { guild: this.guild.id, message: error.message }));
    networking.on('close', (code) => logger.warn('Voice WebSocket closed', { guild: this.guild.id, code }));
  }

  async handleDisconnect(connection, state) {
    const cause = describeVoiceState(state);
    logger.warn('Voice connection disconnected', { guild: this.guild.id, cause });
    try {
      // Moved to another channel: Discord reconnects by itself and we land in Signalling/Connecting.
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, this.timings.moveGraceMs),
        entersState(connection, VoiceConnectionStatus.Connecting, this.timings.moveGraceMs)
      ]);
      return;
    } catch { /* not moved - fall through */ }
    if (this.connection !== connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;

    const kicked = state.reason === VoiceConnectionDisconnectReason.WebSocketClose && state.closeCode === WS_CLOSE_KICKED;
    if (kicked || state.reason === VoiceConnectionDisconnectReason.Manual) {
      logger.warn('Bot was removed from the voice channel; cleaning up', { guild: this.guild.id, cause });
      this.notify({ embeds: [errorEmbed('تم فصلي من القناة الصوتية.')] });
      this.destroy();
      return;
    }
    if (this.rejoinAttempts >= MAX_REJOIN_ATTEMPTS) {
      logger.error('Voice reconnect attempts exhausted', { guild: this.guild.id, cause });
      this.notify({ embeds: [errorEmbed('انقطع الاتصال الصوتي ولم أستطع إعادته. أعد تشغيل الأمر /play.')] });
      this.destroy();
      return;
    }
    this.rejoinAttempts += 1;
    const delay = Math.min(30_000, this.rejoinAttempts * this.timings.rejoinBaseMs);
    logger.info('Rejoining voice channel', { guild: this.guild.id, attempt: this.rejoinAttempts, delayMs: delay });
    await sleep(delay);
    if (this.connection === connection && connection.state.status === VoiceConnectionStatus.Disconnected) {
      if (!connection.rejoin()) logger.warn('rejoin() was refused', { guild: this.guild.id });
    }
  }

  /** Called on voiceStateUpdate events: leave after the channel has been empty for a while. */
  scheduleIdleCheck() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.idleLeaveMs || !this.connection || this.destroyed) return;
    const channel = this.guild.channels?.cache?.get(this.connection.joinConfig.channelId);
    const humans = channel?.members?.filter((member) => !member.user.bot).size ?? 1;
    if (humans > 0) return;
    this.idleTimer = setTimeout(() => {
      logger.info('Leaving empty voice channel', { guild: this.guild.id });
      this.notify({ embeds: [errorEmbed('غادرت القناة الصوتية لأنها فارغة.')] });
      this.destroy();
    }, this.idleLeaveMs);
    this.idleTimer.unref?.();
  }

  ensureControl(interaction) {
    const userChannel = interaction.member?.voice?.channel;
    const botChannelId = this.connection?.joinConfig?.channelId;
    if (!userChannel) throw new UserInputError('يجب أن تكون في قناة صوتية.');
    if (botChannelId && userChannel.id !== botChannelId) throw new UserInputError('يجب أن تكون في نفس قناتي الصوتية.');
  }

  // ---------------------------------------------------------------- queue

  async add(tracks, channel) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (this.queue.length + list.length > MAX_QUEUE_SIZE) throw new UserInputError(`الطابور ممتلئ (الحد ${MAX_QUEUE_SIZE} مسار).`);
    await this.join(channel);
    this.queue.push(...list);
    if (!this.current && !this.starting) await this.playNext({ throwOnFailure: true });
  }

  async playNext({ throwOnFailure = false } = {}) {
    if (this.starting || this.current || this.destroyed) return;
    this.starting = true;
    let lastError = null;
    try {
      while (this.queue.length && !this.destroyed) {
        const track = this.queue.shift();
        try {
          await this.start(track);
          return;
        } catch (error) {
          lastError = error;
          logger.error('Track failed', { guild: this.guild.id, title: track.title, source: track.source, message: error.message });
          this.cleanupResource();
          this.current = null;
          if (!throwOnFailure) this.notify({ embeds: [errorEmbed(`تعذّر تشغيل **${track.title}**: ${error.message}`)] });
        }
      }
    } finally {
      this.starting = false;
    }
    if (lastError && throwOnFailure) throw lastError;
  }

  async start(track) {
    if (this.resolver && (!track.url || track.stale)) await this.resolver.ensureStream(track);
    let resource;
    try {
      resource = await this.source.create(track, { volume: this.volume / 100 });
    } catch (error) {
      // Stream links can expire while queued; re-resolve once from the page URL and retry.
      if (!this.resolver || !track.pageUrl || track.retried) throw error;
      track.retried = true;
      logger.warn('Retrying track with a fresh stream URL', { guild: this.guild.id, title: track.title });
      track.stale = true;
      await this.resolver.ensureStream(track);
      resource = await this.source.create(track, { volume: this.volume / 100 });
    }
    this.current = track;
    this.resource = resource;
    this.failing = false;
    this.player.play(resource);
    logger.info('Track started', { guild: this.guild.id, title: track.title, source: track.source });
    this.notify({ embeds: [nowPlayingEmbed(track, this)] });
  }

  finishCurrent() {
    if (!this.current) return;
    const track = this.current;
    logger.info('Track ended', { guild: this.guild.id, title: track.title, playbackMs: this.resource?.playbackDuration ?? null });
    const skipped = this.skipping;
    const failed = this.failing;
    this.skipping = false;
    this.failing = false;
    this.cleanupResource();
    this.current = null;
    if (this.loop === 'track' && !skipped && !failed) this.queue.unshift(track);
    else if (this.loop === 'queue' && !failed) this.queue.push(track);
    void this.playNext().catch((error) => logger.error('Queue playback failed', { guild: this.guild.id, message: error.message }));
  }

  cleanupResource() { if (this.resource?.cleanup) this.resource.cleanup(); this.resource = null; }

  pause() { if (!this.current || !this.player.pause()) throw new UserInputError('لا يوجد شيء يعمل حالياً.'); }
  resume() { if (!this.current || !this.player.unpause()) throw new UserInputError('لا يوجد شيء متوقف مؤقتاً.'); }
  skip() {
    if (!this.current) throw new UserInputError('لا يوجد شيء يعمل حالياً.');
    this.skipping = true;
    this.player.stop(true);
  }
  stop() { this.queue = []; this.loop = 'off'; this.cleanupResource(); this.current = null; this.player.stop(true); }

  remove(position) {
    if (!Number.isInteger(position) || position < 1 || position > this.queue.length) throw new UserInputError('رقم المسار غير صحيح.');
    return this.queue.splice(position - 1, 1)[0];
  }

  clear() { const count = this.queue.length; this.queue = []; return count; }

  shuffle() {
    if (this.queue.length < 2) throw new UserInputError('لا توجد مسارات كافية للخلط.');
    for (let i = this.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  setLoop(mode) {
    if (!LOOP_MODES.includes(mode)) throw new UserInputError('وضع التكرار غير صحيح.');
    this.loop = mode;
  }

  setVolume(value) {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new UserInputError('مستوى الصوت يجب أن يكون بين 1 و 100.');
    this.volume = value;
    this.resource?.volume?.setVolume(value / 100);
  }

  /** Playback position in whole seconds. */
  get elapsedSeconds() { return Math.floor((this.resource?.playbackDuration ?? 0) / 1000); }

  leave() {
    this.stop();
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      this.detach(connection);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.idleTimer);
    this.leave();
    this.player.stop(true);
    this.player.removeAllListeners();
    this.player.on('error', () => {});
    this.onDestroy(this.guild.id, this);
  }
}

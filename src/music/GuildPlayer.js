import { AudioPlayerStatus, VoiceConnectionStatus, createAudioPlayer, createAudioResource, joinVoiceChannel, entersState } from '@discordjs/voice';
import { AudioSource } from './AudioSource.js';
import { UserInputError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export class GuildPlayer {
  constructor(guild, { ffmpegPath, source = new AudioSource({ ffmpegPath }), player = createAudioPlayer() } = {}) {
    this.guild = guild;
    this.queue = [];
    this.current = null;
    this.connection = null;
    this.resource = null;
    this.player = player;
    this.source = source;
    this.starting = false;
    this.player.on(AudioPlayerStatus.Idle, () => this.finishCurrent());
    this.player.on('error', (error) => { logger.error('Audio player error', { guild: guild.id, message: error.message }); this.cleanupResource(); this.finishCurrent(); });
  }

  async join(channel) {
    if (!channel?.joinable || !channel.speakable) throw new UserInputError('I need permission to connect and speak in that voice channel.');
    if (this.connection && this.connection.joinConfig.channelId !== channel.id) this.leave();
    if (!this.connection) {
      this.connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
      this.connection.subscribe(this.player);
      this.connection.on('stateChange', (oldState, newState) => logger.info('Voice connection state changed', { guild: this.guild.id, from: oldState.status, to: newState.status }));
      this.connection.on('error', (error) => logger.error('Voice connection error', { guild: this.guild.id, message: error.message }));
      try { await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000); }
      catch { this.connection.destroy(); this.connection = null; throw new Error('Discord voice connection did not become ready.'); }
    }
    return this.connection;
  }

  ensureControl(interaction) {
    const userChannel = interaction.member?.voice?.channel;
    const botChannelId = this.connection?.joinConfig?.channelId;
    if (!userChannel) throw new UserInputError('You must be in a voice channel.');
    if (botChannelId && userChannel.id !== botChannelId) throw new UserInputError('You must be in the same voice channel as me.');
  }

  async add(track, channel) {
    await this.join(channel);
    this.queue.push(track);
    if (!this.current && !this.starting) await this.playNext();
  }

  async playNext() {
    if (this.starting || this.current || !this.queue.length) return;
    this.starting = true;
    const track = this.queue.shift();
    try {
      const resource = await this.source.create(track);
      this.current = track;
      this.resource = resource;
      this.player.play(resource);
      logger.info('Track started', { guild: this.guild.id, title: track.title });
    } catch (error) {
      logger.error('Track failed', { guild: this.guild.id, message: error.message });
      this.cleanupResource();
      this.current = null;
      this.starting = false;
      if (this.queue.length) {
        void this.playNext().catch((nextError) => logger.error('Queue playback failed', { guild: this.guild.id, message: nextError.message }));
      }
      throw error;
    }
    this.starting = false;
  }

  finishCurrent() {
    if (!this.current) return;
    logger.info('Track ended', { guild: this.guild.id, title: this.current.title });
    this.cleanupResource();
    this.current = null;
    void this.playNext().catch((error) => logger.error('Queue playback failed', { guild: this.guild.id, message: error.message }));
  }

  cleanupResource() { if (this.resource?.cleanup) this.resource.cleanup(); this.resource = null; }
  pause() { if (!this.current || !this.player.pause()) throw new UserInputError('Nothing is currently playing.'); }
  resume() { if (!this.current || !this.player.unpause()) throw new UserInputError('Nothing is paused.'); }
  skip() { if (!this.current) throw new UserInputError('Nothing is currently playing.'); this.cleanupResource(); this.player.stop(true); }
  stop() { this.queue = []; this.cleanupResource(); this.current = null; this.player.stop(true); }
  leave() { this.stop(); this.connection?.destroy(); this.connection = null; }
  destroy() { this.leave(); this.player.stop(); }
}

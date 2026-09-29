import { SourceResolver } from '../resolvers/SourceResolver.js';
import { GuildPlayer } from './GuildPlayer.js';

export class MusicManager {
  constructor(config) {
    this.config = config;
    this.resolver = new SourceResolver();
    this.players = new Map();
  }

  get(guild) {
    let player = this.players.get(guild.id);
    if (!player) {
      player = new GuildPlayer(guild, this.config);
      this.players.set(guild.id, player);
    }
    return player;
  }

  remove(guildId) {
    const player = this.players.get(guildId);
    player?.destroy();
    this.players.delete(guildId);
  }

  destroyAll() {
    for (const player of this.players.values()) player.destroy();
    this.players.clear();
  }
}

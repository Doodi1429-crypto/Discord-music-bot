import { SourceResolver } from '../resolvers/SourceResolver.js';
import { GuildPlayer } from './GuildPlayer.js';

export class MusicManager {
  constructor(config, { resolver = new SourceResolver() } = {}) {
    this.config = config;
    this.resolver = resolver;
    this.players = new Map();
  }

  get(guild) {
    let player = this.players.get(guild.id);
    if (!player || player.destroyed) {
      player = new GuildPlayer(guild, this.config, {
        resolver: this.resolver,
        onDestroy: (guildId, destroyed) => { if (this.players.get(guildId) === destroyed) this.players.delete(guildId); }
      });
      this.players.set(guild.id, player);
    }
    return player;
  }

  remove(guildId) {
    this.players.get(guildId)?.destroy();
    this.players.delete(guildId);
  }

  destroyAll() {
    for (const player of [...this.players.values()]) player.destroy();
    this.players.clear();
  }
}

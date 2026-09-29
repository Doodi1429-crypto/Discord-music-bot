import { GuildPlayer } from './GuildPlayer.js';
import { SourceResolver } from '../resolvers/SourceResolver.js';

export class MusicManager {
  constructor(config, { resolver = new SourceResolver() } = {}) { this.config = config; this.resolver = resolver; this.players = new Map(); }
  resolve(input) { return this.resolver.resolve(input); }
  get(guild) {
    let player = this.players.get(guild.id);
    if (!player) { player = new GuildPlayer(guild, this.config); this.players.set(guild.id, player); }
    return player;
  }
  remove(guildId) { const player = this.players.get(guildId); player?.destroy(); this.players.delete(guildId); }
  destroyAll() { for (const player of this.players.values()) player.destroy(); this.players.clear(); }
}

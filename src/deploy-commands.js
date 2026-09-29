import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { data as play } from './commands/play.js';

const config = loadConfig();
const rest = new REST({ version: '10' }).setToken(config.token);
const body = [play.toJSON()];
const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);

try {
  await rest.put(route, { body });
  console.log(`Registered /play ${config.guildId ? `in guild ${config.guildId}` : 'globally'}.`);
} catch (error) {
  console.error('Failed to register /play command:', error);
  process.exitCode = 1;
}

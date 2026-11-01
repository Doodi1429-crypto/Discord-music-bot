import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { commands } from './commands/index.js';

const config = loadConfig();
const rest = new REST({ version: '10', timeout: 30_000 }).setToken(config.token);
const body = commands.map(({ data }) => data.toJSON());
const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);

try {
  await rest.put(route, { body });
  console.log(`Registered ${body.length} commands (${body.map((c) => `/${c.name}`).join(' ')}) ${config.guildId ? `in guild ${config.guildId}` : 'globally'}.`);
} catch (error) {
  console.error('Failed to register commands:', error);
  process.exitCode = 1;
}

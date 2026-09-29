import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { commands } from './index.js';

const config = loadConfig();
const rest = new REST({ version: '10' }).setToken(config.token);
const body = commands.map(command => command.data.toJSON());
const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
await rest.put(route, { body });
console.log(`Registered ${body.length} slash commands ${config.guildId ? `in guild ${config.guildId}` : 'globally'}.`);

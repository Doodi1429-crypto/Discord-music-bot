import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { MusicManager } from './music/MusicManager.js';
import { userMessage } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { loginWithTimeout } from './startup.js';
import { data as join, execute as joinExecute } from './commands/join.js';
import { data as play, execute as playExecute } from './commands/play.js';
import { data as pause, execute as pauseExecute } from './commands/pause.js';
import { data as resume, execute as resumeExecute } from './commands/resume.js';
import { data as skip, execute as skipExecute } from './commands/skip.js';
import { data as stop, execute as stopExecute } from './commands/stop.js';
import { data as queue, execute as queueExecute } from './commands/queue.js';
import { data as nowplaying, execute as nowplayingExecute } from './commands/nowplaying.js';
import { data as leave, execute as leaveExecute } from './commands/leave.js';

export const commands = [
  { data: join, execute: joinExecute }, { data: play, execute: playExecute },
  { data: pause, execute: pauseExecute }, { data: resume, execute: resumeExecute },
  { data: skip, execute: skipExecute }, { data: stop, execute: stopExecute },
  { data: queue, execute: queueExecute }, { data: nowplaying, execute: nowplayingExecute },
  { data: leave, execute: leaveExecute }
];

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const manager = new MusicManager(config);
const commandMap = new Collection(commands.map(command => [command.data.name, command]));

client.once('ready', ready => logger.info(`Logged in as ${ready.user.tag}`));
client.on('error', error => logger.error('Client error', { message: error.message }));
client.on('shardError', error => logger.error('Shard connection error', { message: error.message }));
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;
  try { await command.execute(interaction, manager); }
  catch (error) {
    logger.error('Command failed', { command: interaction.commandName, guild: interaction.guild.id, message: error.message });
    const content = userMessage(error);
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, ephemeral: true }).catch(() => {});
  }
});
client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member?.id !== client.user?.id || newState.channelId) return;
  manager.remove(oldState.guild.id);
});
process.on('SIGINT', () => { manager.destroyAll(); client.destroy(); process.exit(0); });
process.on('SIGTERM', () => { manager.destroyAll(); client.destroy(); process.exit(0); });
logger.info('Connecting to Discord gateway...');
loginWithTimeout(client, config.token, { timeoutMs: config.loginTimeoutMs })
  .catch(async error => {
    logger.error('Login failed', { message: error.message });
    process.exitCode = 1;
    await client.destroy().catch(() => {});
    // A hung/stuck gateway connection can leave open sockets that keep the event loop alive
    // indefinitely even after destroy(); exit explicitly so the host's process manager restarts
    // it. setImmediate gives the logger's synchronous console writes a turn of the event loop
    // to flush before the process terminates.
    setImmediate(() => process.exit(1));
  });

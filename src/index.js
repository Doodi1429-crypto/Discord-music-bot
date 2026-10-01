import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { MusicManager } from './music/MusicManager.js';
import { userMessage } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { loginWithTimeout } from './startup.js';
import { startYtDlpPotProvider } from './resolvers/ytDlpPotProvider.js';
import { AIService } from './ai/AIService.js';
import { handleAIMessage } from './ai/discordHandler.js';
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
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
const manager = new MusicManager(config);
const aiService = config.ai.enabled ? new AIService(config.ai) : null;
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
client.on('messageCreate', message => {
  if (!aiService || message.author?.bot || !client.user?.id) return;
  void handleAIMessage(message, { service: aiService, config: config.ai, botId: client.user.id, logger });
});
client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member?.id !== client.user?.id || newState.channelId) return;
  manager.remove(oldState.guild.id);
});
function safeDestroy(destroyableClient) {
  try { destroyableClient.destroy().catch(() => {}); } catch { /* best-effort cleanup only */ }
}

let stopPotProvider = async () => {};

async function shutdown() {
  manager.destroyAll();
  client.destroy();
  await stopPotProvider();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

async function start() {
  try {
    const provider = await startYtDlpPotProvider();
    stopPotProvider = provider.stop;
    if (provider.started) logger.info('Local YouTube PO-token provider is ready.');
  } catch (error) {
    logger.error('Local YouTube PO-token provider failed to start; yt-dlp fallback may fail', {
      message: error.message
    });
  }

  logger.info('Connecting to Discord gateway...');
  loginWithTimeout(client, config.token, { timeoutMs: config.loginTimeoutMs })
    .catch(error => {
      logger.error('Login failed', { message: error.message });
      // Don't await destroy(): on the exact failure this guards against (a stuck/blackholed
      // connection), destroy() could hang for the same reason login did, which would defeat the
      // point of exiting promptly. Let it run best-effort in the background.
      safeDestroy(client);
      // setImmediate gives the logger's synchronous console write and the destroy() call above a
      // turn of the event loop before the process terminates; exit explicitly since a hung
      // connection's open sockets could otherwise keep the event loop alive indefinitely.
      setImmediate(() => {
        void stopPotProvider().finally(() => process.exit(1));
      });
    });
}

void start();

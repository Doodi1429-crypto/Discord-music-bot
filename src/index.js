import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { MusicManager } from './music/MusicManager.js';
import { arabicError } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { loginWithTimeout } from './startup.js';
import { startYtDlpPotProvider } from './resolvers/ytDlpPotProvider.js';
import { AIService } from './ai/AIService.js';
import { handleAIMessage } from './ai/discordHandler.js';
import { commands } from './commands/index.js';
import { startHeartbeat, healthSnapshot } from './health.js';
import { startHttpHealthServer } from './httpHealth.js';
import { RateLimiter } from './utils/rateLimiter.js';
import { acquireProcessLock } from './utils/processLock.js';
import { errorEmbed } from './ui/embeds.js';
import { REST, Routes } from 'discord.js';

export { commands };

const config = loadConfig();
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
if (config.ai.enabled) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
const client = new Client({
  intents
});
const manager = new MusicManager(config);
const aiService = config.ai.enabled ? new AIService(config.ai) : null;
const commandMap = new Collection(commands.map(command => [command.data.name, command]));
const userLimiter = new RateLimiter({ limit: 5, windowMs: 10_000 });
const playLimiter = new RateLimiter({ limit: 5, windowMs: 60_000 });
let releaseLock = () => {};
let heartbeat = null;
let stopHttp = async () => {};

async function registerCommands() {
  if (process.env.REGISTER_COMMANDS?.trim().toLowerCase() === 'false') return;
  const rest = new REST({ version: '10', timeout: 30_000 }).setToken(config.token);
  const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
  try {
    await rest.put(route, { body: commands.map(({ data }) => data.toJSON()) });
    logger.info('Slash commands registered', { count: commands.length, scope: config.guildId ? 'guild' : 'global' });
  } catch (error) {
    logger.error('Slash command registration failed', { message: error.message });
  }
}

client.once('ready', ready => {
  logger.info(`Logged in as ${ready.user.tag}`);
  void registerCommands();
});
client.on('error', error => logger.error('Client error', { message: error.message }));
client.on('shardError', error => logger.error('Shard connection error', { message: error.message }));
client.on('shardDisconnect', (event, id) => logger.warn('Shard disconnected', { shard: id, code: event.code }));
client.on('shardReconnecting', id => logger.info('Shard reconnecting', { shard: id }));
client.on('shardResume', (id, replayed) => logger.info('Shard resumed', { shard: id, replayedEvents: replayed }));
client.on('invalidated', () => { logger.error('Discord session invalidated; exiting for restart'); void shutdown(1); });
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;
  const wait = Math.max(userLimiter.check(interaction.user.id), interaction.commandName === 'play' ? playLimiter.check(interaction.user.id) : 0);
  if (wait > 0) {
    await interaction.reply({ embeds: [errorEmbed(`مهلاً! حاول بعد ${Math.ceil(wait / 1000)} ثانية.`)], ephemeral: true }).catch(() => {});
    return;
  }
  try { await command.execute(interaction, manager); }
  catch (error) {
    logger.error('Command failed', { command: interaction.commandName, guild: interaction.guild.id, message: error.message });
    const payload = { embeds: [errorEmbed(arabicError(error))] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  }
});
client.on('messageCreate', message => {
  if (!aiService || message.author?.bot || !client.user?.id) return;
  void handleAIMessage(message, { service: aiService, config: config.ai, botId: client.user.id, logger });
});
client.on('voiceStateUpdate', (oldState, newState) => {
  // Bot disconnects are handled (and recovered from) by GuildPlayer's connection state machine.
  // Here we only re-evaluate the "empty channel" auto-leave timer.
  manager.players.get(newState.guild.id)?.scheduleIdleCheck();
});
function safeDestroy(destroyableClient) {
  try { destroyableClient.destroy().catch(() => {}); } catch { /* best-effort cleanup only */ }
}

let stopPotProvider = async () => {};
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down gracefully', { exitCode: code });
  // Never hang on shutdown: Render sends SIGKILL shortly after SIGTERM anyway.
  setTimeout(() => process.exit(code || 1), 8_000).unref();
  try {
    heartbeat?.stop();
    await stopHttp();
    manager.destroyAll();
    await client.destroy();
    await stopPotProvider();
  } catch (error) {
    logger.error('Error during shutdown', { message: error.message });
  } finally {
    releaseLock();
    process.exit(code);
  }
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', { message: reason?.message ?? String(reason) }));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception; restarting', { message: error.message, stack: error.stack });
  void shutdown(1);
});

async function logGatewayReachability() {
  try {
    const res = await fetch('https://discord.com/api/v10/gateway', { signal: AbortSignal.timeout(10_000) });
    logger.info('Discord API reachable', { httpStatus: res.status });
  } catch (error) {
    logger.error('Discord API preflight failed', { name: error.name, code: error.cause?.code ?? error.code, message: error.message });
  }
}

async function start() {
  try {
    releaseLock = acquireProcessLock();
  } catch (error) {
    logger.error(error.message);
    process.exit(1);
  }
  stopHttp = startHttpHealthServer({
    logger,
    getStatus: () => { const { status, ready } = healthSnapshot(client, manager); return { status, ready }; }
  }).stop;

  // Started in the background so it can't delay or compete with the Discord login on a small host.
  startYtDlpPotProvider()
    .then(provider => {
      stopPotProvider = provider.stop;
      if (provider.started) logger.info('Local YouTube PO-token provider is ready.');
    })
    .catch(error => {
      logger.error('Local YouTube PO-token provider failed to start; continuing without it (yt-dlp fallback may fail)', {
        message: error.message
      });
    });

  await logGatewayReachability();
  logger.info('Connecting to Discord gateway...');
  heartbeat = startHeartbeat({
    client, manager, intervalMs: config.heartbeatIntervalMs,
    onUnhealthy: () => { void shutdown(1); }
  });
  loginWithTimeout(client, config.token, { timeoutMs: config.loginTimeoutMs })
    .catch(error => {
      logger.error('Login failed', { name: error.name, code: error.code ?? error.cause?.code, wsStatus: client.ws?.status, message: error.message });
      // Don't await destroy(): on the exact failure this guards against (a stuck/blackholed
      // connection), destroy() could hang for the same reason login did, which would defeat the
      // point of exiting promptly. Let it run best-effort in the background.
      safeDestroy(client);
      // setImmediate gives the logger's synchronous console write and the destroy() call above a
      // turn of the event loop before the process terminates; exit explicitly since a hung
      // connection's open sockets could otherwise keep the event loop alive indefinitely.
      setImmediate(() => {
        void stopPotProvider().finally(() => { releaseLock(); process.exit(1); });
      });
    });
}

void start();

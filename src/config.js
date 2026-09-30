import 'dotenv/config';
import { DEFAULT_LOGIN_TIMEOUT_MS } from './startup.js';

const required = ['DISCORD_TOKEN', 'CLIENT_ID'];

export function loadConfig() {
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (process.env.GUILD_ID && !/^\d{17,20}$/.test(process.env.GUILD_ID)) {
    throw new Error('GUILD_ID must be a Discord snowflake when provided.');
  }
  if (!/^\d{17,20}$/.test(process.env.CLIENT_ID)) {
    throw new Error('CLIENT_ID must be a Discord application snowflake.');
  }

  const loginTimeoutMs = Number(process.env.LOGIN_TIMEOUT_MS);

  return {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID || null,
    ffmpegPath: process.env.FFMPEG_PATH || null,
    logLevel: process.env.LOG_LEVEL || 'info',
    // Both checks are required: Number(undefined) is NaN (rejected by isFinite), but
    // Number('') is 0, which is finite - the `> 0` check is what rejects an empty/blank value.
    loginTimeoutMs: Number.isFinite(loginTimeoutMs) && loginTimeoutMs > 0 ? loginTimeoutMs : DEFAULT_LOGIN_TIMEOUT_MS
  };
}

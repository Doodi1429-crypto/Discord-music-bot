import 'dotenv/config';

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

  return {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID || null,
    ffmpegPath: process.env.FFMPEG_PATH || null,
    logLevel: process.env.LOG_LEVEL || 'info'
  };
}

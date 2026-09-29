import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current track.');
export async function execute(i, m) { const current = m.get(i.guild).current; return i.reply(current ? `Now playing: **${current.title}**` : 'Nothing is currently playing.'); }

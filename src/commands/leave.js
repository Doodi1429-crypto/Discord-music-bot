import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('leave').setDescription('Leave voice and clear playback.');
export async function execute(i, m) { const p = m.get(i.guild); p.ensureControl(i); p.leave(); return i.reply('Left the voice channel.'); }

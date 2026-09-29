import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('resume').setDescription('Resume playback.');
export async function execute(i, m) { m.get(i.guild).ensureControl(i); m.get(i.guild).resume(); return i.reply('Playback resumed.'); }

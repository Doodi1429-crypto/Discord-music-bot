import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue.');
export async function execute(i, m) { m.get(i.guild).ensureControl(i); m.get(i.guild).stop(); return i.reply('Playback stopped and queue cleared.'); }

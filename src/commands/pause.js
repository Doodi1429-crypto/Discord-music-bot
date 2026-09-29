import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('pause').setDescription('Pause playback.');
export async function execute(i, m) { m.get(i.guild).ensureControl(i); m.get(i.guild).pause(); return i.reply('Playback paused.'); }

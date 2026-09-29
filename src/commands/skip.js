import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('skip').setDescription('Skip the current track.');
export async function execute(i, m) { m.get(i.guild).ensureControl(i); m.get(i.guild).skip(); return i.reply('Skipped.'); }

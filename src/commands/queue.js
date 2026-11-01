import { SlashCommandBuilder } from 'discord.js';
import { queueEmbed } from '../ui/embeds.js';
export const data = new SlashCommandBuilder().setName('queue').setDescription('عرض الطابور الحالي');
export async function execute(i, m) { return i.reply({ embeds: [queueEmbed(m.get(i.guild))] }); }

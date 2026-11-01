import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';
export const data = new SlashCommandBuilder().setName('skip').setDescription('تخطي المسار الحالي');
export async function execute(i, m) { const p = m.get(i.guild); p.ensureControl(i); p.skip(); return i.reply({ embeds: [successEmbed('تم التخطي ⏭️')] }); }

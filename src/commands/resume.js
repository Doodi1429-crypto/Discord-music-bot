import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';
export const data = new SlashCommandBuilder().setName('resume').setDescription('استئناف التشغيل');
export async function execute(i, m) { const p = m.get(i.guild); p.ensureControl(i); p.resume(); return i.reply({ embeds: [successEmbed('تم استئناف التشغيل ▶️')] }); }

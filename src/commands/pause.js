import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';
export const data = new SlashCommandBuilder().setName('pause').setDescription('إيقاف التشغيل مؤقتاً');
export async function execute(i, m) { const p = m.get(i.guild); p.ensureControl(i); p.pause(); return i.reply({ embeds: [successEmbed('تم الإيقاف المؤقت ⏸️')] }); }

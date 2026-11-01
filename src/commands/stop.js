import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';
export const data = new SlashCommandBuilder().setName('stop').setDescription('إيقاف التشغيل ومسح الطابور');
export async function execute(i, m) { const p = m.get(i.guild); p.ensureControl(i); p.stop(); return i.reply({ embeds: [successEmbed('تم الإيقاف ومسح الطابور ⏹️')] }); }

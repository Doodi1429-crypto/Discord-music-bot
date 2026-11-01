import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';

export const data = new SlashCommandBuilder().setName('clear').setDescription('مسح الطابور (دون إيقاف المسار الحالي)');
export async function execute(i, m) {
  const p = m.get(i.guild);
  p.ensureControl(i);
  return i.reply({ embeds: [successEmbed(`تم مسح ${p.clear()} مسار من الطابور 🧹`)] });
}

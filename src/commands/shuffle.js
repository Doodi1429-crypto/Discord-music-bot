import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';

export const data = new SlashCommandBuilder().setName('shuffle').setDescription('خلط ترتيب الطابور');
export async function execute(i, m) {
  const p = m.get(i.guild);
  p.ensureControl(i);
  p.shuffle();
  return i.reply({ embeds: [successEmbed('تم خلط الطابور 🔀')] });
}

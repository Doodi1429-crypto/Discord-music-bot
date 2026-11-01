import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';

export const data = new SlashCommandBuilder().setName('remove').setDescription('حذف مسار من الطابور')
  .addIntegerOption((o) => o.setName('position').setDescription('رقم المسار في الطابور').setMinValue(1).setRequired(true));
export async function execute(i, m) {
  const p = m.get(i.guild);
  p.ensureControl(i);
  const track = p.remove(i.options.getInteger('position', true));
  return i.reply({ embeds: [successEmbed(`تم حذف **${track.title}** من الطابور`)] });
}

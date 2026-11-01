import { SlashCommandBuilder } from 'discord.js';
import { nowPlayingEmbed, errorEmbed, formatDuration } from '../ui/embeds.js';
export const data = new SlashCommandBuilder().setName('nowplaying').setDescription('عرض المسار الحالي');
export async function execute(i, m) {
  const p = m.get(i.guild);
  if (!p.current) return i.reply({ embeds: [errorEmbed('لا يوجد شيء يعمل حالياً.')], ephemeral: true });
  const embed = nowPlayingEmbed(p.current, p).addFields({ name: 'التقدم', value: `${formatDuration(p.elapsedSeconds)} / ${formatDuration(p.current.duration)}`, inline: true });
  return i.reply({ embeds: [embed] });
}

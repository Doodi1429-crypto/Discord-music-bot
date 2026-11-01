import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';

export const data = new SlashCommandBuilder().setName('volume').setDescription('ضبط مستوى الصوت')
  .addIntegerOption((o) => o.setName('level').setDescription('من 1 إلى 100').setMinValue(1).setMaxValue(100).setRequired(true));
export async function execute(i, m) {
  const p = m.get(i.guild);
  p.ensureControl(i);
  p.setVolume(i.options.getInteger('level', true));
  return i.reply({ embeds: [successEmbed(`مستوى الصوت الآن **${p.volume}%** 🔊`)] });
}

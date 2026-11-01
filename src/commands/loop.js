import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';

const LABELS = { off: 'التكرار متوقف', track: 'تكرار المسار الحالي 🔂', queue: 'تكرار الطابور 🔁' };

export const data = new SlashCommandBuilder().setName('loop').setDescription('ضبط وضع التكرار')
  .addStringOption((o) => o.setName('mode').setDescription('وضع التكرار').setRequired(true)
    .addChoices({ name: 'متوقف', value: 'off' }, { name: 'المسار الحالي', value: 'track' }, { name: 'الطابور', value: 'queue' }));
export async function execute(i, m) {
  const p = m.get(i.guild);
  p.ensureControl(i);
  p.setLoop(i.options.getString('mode', true));
  return i.reply({ embeds: [successEmbed(LABELS[p.loop])] });
}

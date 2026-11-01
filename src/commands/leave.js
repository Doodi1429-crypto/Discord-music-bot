import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../ui/embeds.js';
export const data = new SlashCommandBuilder().setName('leave').setDescription('مغادرة القناة الصوتية ومسح التشغيل');
export async function execute(i, m) { const p = m.get(i.guild); p.ensureControl(i); m.remove(i.guild.id); return i.reply({ embeds: [successEmbed('غادرت القناة الصوتية 👋')] }); }

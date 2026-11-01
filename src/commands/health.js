import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { infoEmbed } from '../ui/embeds.js';
import { healthSnapshot } from '../health.js';

export const data = new SlashCommandBuilder().setName('health').setDescription('حالة البوت والاتصال (للمشرفين)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
export async function execute(i, m) {
  const h = healthSnapshot(i.client, m);
  const text = [
    `الحالة: **${h.status}**`, `Ping: ${h.pingMs}ms`, `مدة التشغيل: ${h.uptimeMin} دقيقة`,
    `الاتصالات الصوتية: ${h.voiceConnections}`, `الذاكرة: ${h.rssMb}MB`
  ].join('\n');
  return i.reply({ ephemeral: true, embeds: [infoEmbed('🩺 صحة البوت', text)] });
}

import { EmbedBuilder } from 'discord.js';

const COLORS = { youtube: 0xff0000, soundcloud: 0xff5500, generic: 0x5865f2, ok: 0x57f287, error: 0xed4245, info: 0x5865f2 };
const SOURCE_LABELS = { youtube: 'YouTube', soundcloud: 'SoundCloud', generic: 'رابط مباشر' };
const LOOP_LABELS = { off: 'متوقف', track: 'تكرار المسار', queue: 'تكرار الطابور' };

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'غير معروف';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const link = (track) => (track.pageUrl ? `[${clip(track.title, 80)}](${track.pageUrl})` : clip(track.title, 80));

export function nowPlayingEmbed(track, player) {
  const embed = new EmbedBuilder()
    .setColor(COLORS[track.source] ?? COLORS.info)
    .setTitle('🎶 يعمل الآن')
    .setDescription(link(track))
    .addFields(
      { name: 'المدة', value: formatDuration(track.duration), inline: true },
      { name: 'المصدر', value: SOURCE_LABELS[track.source] ?? 'غير معروف', inline: true },
      { name: 'الصوت', value: `${player.volume}%`, inline: true },
      { name: 'التكرار', value: LOOP_LABELS[player.loop], inline: true },
      { name: 'في الطابور', value: String(player.queue.length), inline: true }
    );
  if (track.requestedBy) embed.setFooter({ text: `طلب بواسطة ${track.requestedBy}` });
  if (/^https:\/\//.test(track.thumbnail ?? '')) embed.setThumbnail(track.thumbnail);
  return embed;
}

export function queuedEmbed(track, position) {
  return new EmbedBuilder().setColor(COLORS.ok).setTitle('✅ أضيف إلى الطابور')
    .setDescription(link(track))
    .addFields({ name: 'الترتيب', value: String(position), inline: true }, { name: 'المدة', value: formatDuration(track.duration), inline: true });
}

export function playlistEmbed(title, count, limit) {
  return new EmbedBuilder().setColor(COLORS.ok).setTitle('📃 أضيفت قائمة تشغيل')
    .setDescription(`**${clip(title, 100)}**\nتمت إضافة ${count} مسار (الحد الأقصى ${limit}).`);
}

export function queueEmbed(player) {
  const lines = player.queue.slice(0, 15).map((t, i) => `**${i + 1}.** ${clip(t.title, 70)} \`${formatDuration(t.duration)}\``);
  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('📜 الطابور')
    .addFields({ name: 'الآن', value: player.current ? clip(player.current.title, 100) : 'لا شيء يعمل' });
  embed.addFields({ name: 'التالي', value: lines.join('\n') || 'الطابور فارغ' });
  const more = player.queue.length - 15;
  embed.setFooter({ text: `${player.queue.length} مسار • التكرار: ${LOOP_LABELS[player.loop]}${more > 0 ? ` • و${more} آخرين` : ''}` });
  return embed;
}

export const successEmbed = (text) => new EmbedBuilder().setColor(COLORS.ok).setDescription(`✅ ${text}`);
export const errorEmbed = (text) => new EmbedBuilder().setColor(COLORS.error).setDescription(`❌ ${clip(String(text), 1000)}`);
export const infoEmbed = (title, text) => new EmbedBuilder().setColor(COLORS.info).setTitle(title).setDescription(text);

import { SlashCommandBuilder } from 'discord.js';
import { infoEmbed } from '../ui/embeds.js';

export const data = new SlashCommandBuilder().setName('help').setDescription('عرض قائمة الأوامر');
export async function execute(i) {
  return i.reply({
    ephemeral: true,
    embeds: [infoEmbed('🎵 أوامر البوت', [
      '`/play` تشغيل رابط أو بحث (يوتيوب / ساوندكلاود / قوائم تشغيل حتى 25 مسار)',
      '`/pause` `/resume` إيقاف مؤقت / استئناف',
      '`/skip` تخطي • `/stop` إيقاف ومسح الطابور • `/leave` مغادرة',
      '`/queue` عرض الطابور • `/nowplaying` المسار الحالي',
      '`/remove` حذف مسار • `/clear` مسح الطابور • `/shuffle` خلط',
      '`/loop` تكرار المسار أو الطابور • `/volume` مستوى الصوت',
      '`/join` الانضمام إلى قناتك الصوتية'
    ].join('\n'))]
  });
}

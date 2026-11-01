import { SlashCommandBuilder } from 'discord.js';
import { errorEmbed, playlistEmbed, queuedEmbed } from '../ui/embeds.js';
import { MAX_PLAYLIST_TRACKS } from '../resolvers/SoundCloudResolver.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('تشغيل رابط أو بحث من يوتيوب / ساوندكلاود')
  .addStringOption((option) => option
    .setName('url')
    .setDescription('رابط (يوتيوب، ساوندكلاود، قائمة تشغيل، رابط صوتي مباشر) أو كلمات البحث')
    .setRequired(true)
    .setMaxLength(500))
  .addStringOption((option) => option
    .setName('source')
    .setDescription('مصدر البحث (الافتراضي: يوتيوب ثم ساوندكلاود عند الفشل)')
    .addChoices({ name: 'تلقائي', value: 'auto' }, { name: 'YouTube', value: 'youtube' }, { name: 'SoundCloud', value: 'soundcloud' }));

export async function execute(interaction, manager) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    return interaction.reply({ embeds: [errorEmbed('يجب أن تكون في قناة صوتية.')], ephemeral: true });
  }

  await interaction.deferReply();
  const input = interaction.options.getString('url', true);
  const source = interaction.options.getString('source') ?? 'auto';
  const player = manager.get(interaction.guild);
  player.ensureControl(interaction);
  player.textChannel = interaction.channel;

  const { tracks, playlistTitle } = await manager.resolver.resolveMany(input, { source });
  for (const track of tracks) track.requestedBy = interaction.member.displayName ?? interaction.user.username;
  const position = player.queue.length + (player.current ? 1 : 0) + 1;
  await player.add(tracks, channel);

  if (playlistTitle) return interaction.editReply({ embeds: [playlistEmbed(playlistTitle, tracks.length, MAX_PLAYLIST_TRACKS)] });
  return interaction.editReply({ embeds: [queuedEmbed(tracks[0], position)] });
}

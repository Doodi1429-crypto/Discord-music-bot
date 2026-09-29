import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a YouTube URL, search YouTube, or play a direct media URL.')
  .addStringOption((option) => option
    .setName('url')
    .setDescription('YouTube URL, search query, or direct audio/video URL')
    .setRequired(true));

export async function execute(interaction, manager) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    return interaction.reply({ content: 'You must be in a voice channel.', ephemeral: true });
  }

  await interaction.deferReply();
  const input = interaction.options.getString('url', true);
  const track = await manager.resolver.resolve(input);
  await manager.get(interaction.guild).add(track, channel);
  return interaction.editReply(`Queued **${track.title}**.`);
}

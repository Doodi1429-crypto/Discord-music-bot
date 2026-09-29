import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('play').setDescription('Play a direct audio/video URL.').addStringOption(o => o.setName('url').setDescription('Public direct media URL').setRequired(true));
export async function execute(interaction, manager) {
  const channel = interaction.member.voice.channel;
  if (!channel) return interaction.reply({ content: 'You must be in a voice channel.', ephemeral: true });
  await interaction.deferReply();
  const url = interaction.options.getString('url', true);
  const title = new URL(url).hostname;
  await manager.get(interaction.guild).add({ url, title }, channel);
  return interaction.editReply(`Queued **${title}**.`);
}

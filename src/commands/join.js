import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, errorEmbed } from '../ui/embeds.js';
export const data = new SlashCommandBuilder().setName('join').setDescription('الانضمام إلى قناتك الصوتية');
export async function execute(interaction, manager) {
  const channel = interaction.member.voice.channel;
  if (!channel) return interaction.reply({ embeds: [errorEmbed('يجب أن تكون في قناة صوتية.')], ephemeral: true });
  await interaction.deferReply();
  const player = manager.get(interaction.guild);
  player.textChannel = interaction.channel;
  await player.join(channel);
  return interaction.editReply({ embeds: [successEmbed(`انضممت إلى **${channel.name}** 🔊`)] });
}

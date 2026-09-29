import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('join').setDescription('Join your current voice channel.');
export async function execute(interaction, manager) {
  const channel = interaction.member.voice.channel;
  if (!channel) return interaction.reply({ content: 'You must be in a voice channel.', ephemeral: true });
  await manager.get(interaction.guild).join(channel);
  return interaction.reply(`Joined **${channel.name}**.`);
}

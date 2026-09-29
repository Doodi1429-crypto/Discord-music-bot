import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder().setName('queue').setDescription('Show the current queue.');
export async function execute(i, m) { const p = m.get(i.guild); const list = [p.current ? `Now: **${p.current.title}**` : 'Nothing playing.', ...p.queue.map((t, n) => `${n + 1}. ${t.title}`)]; return i.reply(list.join('\n').slice(0, 1900)); }

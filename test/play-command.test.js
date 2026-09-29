import test from 'node:test';
import assert from 'node:assert/strict';
import { data, execute } from '../src/commands/play.js';

test('/play resolves YouTube search input and queues the resolved track', async () => {
  const channel = { id: 'voice' };
  const guild = { id: 'guild' };
  const track = { title: 'Song', url: 'https://media.example/audio', source: 'youtube' };
  const calls = [];
  const interaction = {
    member: { voice: { channel } },
    guild,
    options: { getString: (name, required) => { calls.push(['input', name, required]); return 'a song'; } },
    deferReply: async () => { calls.push(['defer']); },
    editReply: async (message) => { calls.push(['reply', message]); }
  };
  const manager = {
    resolve: async (input) => { calls.push(['resolve', input]); return track; },
    get: (targetGuild) => {
      assert.equal(targetGuild, guild);
      return { add: async (queuedTrack, targetChannel) => calls.push(['add', queuedTrack, targetChannel]) };
    }
  };

  await execute(interaction, manager);
  assert.deepEqual(calls, [
    ['defer'],
    ['input', 'url', true],
    ['resolve', 'a song'],
    ['add', track, channel],
    ['reply', 'Queued **Song**.']
  ]);
  assert.match(data.toJSON().description, /YouTube/);
});

test('/play preserves the voice-channel requirement', async () => {
  let replied;
  await execute({ member: { voice: {} }, reply: async (value) => { replied = value; } }, {});
  assert.deepEqual(replied, { content: 'You must be in a voice channel.', ephemeral: true });
});

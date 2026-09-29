import { test } from 'node:test';
import assert from 'node:assert/strict';
import prism from 'prism-media';

// This is the pipeline @discordjs/voice uses internally (via prism-media) to Opus-encode raw
// PCM audio produced by AudioSource/ffmpeg before sending it to Discord. On hosts that block
// native module builds/install scripts (e.g. some restricted Node.js hosting providers),
// @discordjs/opus never compiles, and prism-media previously had no other encoder to fall back
// to, causing every track to fail during playback with a generic error. opusscript is a pure
// JavaScript encoder with no install scripts, so it must always be available as a fallback.
test('an Opus encoder is available for @discordjs/voice playback (no native build required)', () => {
  assert.doesNotThrow(() => {
    const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
    encoder.destroy();
  });
});

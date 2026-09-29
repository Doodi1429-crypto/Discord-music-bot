import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserInputError, AudioSourceError, userMessage } from '../src/utils/errors.js';

test('userMessage passes through UserInputError and AudioSourceError messages verbatim', () => {
  assert.equal(userMessage(new UserInputError('You must be in a voice channel.')), 'You must be in a voice channel.');
  assert.equal(userMessage(new AudioSourceError('FFmpeg executable not found.')), 'FFmpeg executable not found.');
});

test('userMessage masks unexpected errors with a generic playback failure message', () => {
  const generic = userMessage(new Error('Cannot find one of the modules "@discordjs/opus"'));
  assert.equal(generic, 'Playback failed. Check that the URL is public, reachable, and points to supported media.');
});

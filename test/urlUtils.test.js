import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidUrl, isYouTubeUrl, extractVideoId, isValidVideoId } from '../src/resolvers/urlUtils.js';

test('isValidUrl accepts http(s) URLs and rejects everything else', () => {
  assert.equal(isValidUrl('https://example.com/audio.mp3'), true);
  assert.equal(isValidUrl('http://example.com/audio.mp3'), true);
  assert.equal(isValidUrl('ftp://example.com/audio.mp3'), false);
  assert.equal(isValidUrl('not a url'), false);
  assert.equal(isValidUrl(''), false);
});

test('isYouTubeUrl detects youtube.com and youtu.be hosts', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://example.com/video.mp4'), false);
});

test('extractVideoId supports standard, short, shorts, live, and embed URLs', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(extractVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});

test('isValidVideoId enforces the 11-character YouTube ID format', () => {
  assert.equal(isValidVideoId('dQw4w9WgXcQ'), true);
  assert.equal(isValidVideoId('short'), false);
  assert.equal(isValidVideoId(null), false);
});

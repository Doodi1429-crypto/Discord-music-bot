import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceResolver } from '../src/resolvers/SourceResolver.js';
import { YouTubeResolver } from '../src/resolvers/YouTubeResolver.js';
import { extractVideoId, isYouTubeUrl } from '../src/resolvers/urlUtils.js';
import { AudioSourceError, UserInputError } from '../src/utils/errors.js';

const videoId = 'abcdefghijk';

test('YouTube URLs include watch, short, and Shorts links', () => {
  assert.equal(extractVideoId(`https://www.youtube.com/watch?v=${videoId}`), videoId);
  assert.equal(extractVideoId(`https://youtu.be/${videoId}`), videoId);
  assert.equal(extractVideoId(`https://m.youtube.com/shorts/${videoId}`), videoId);
  assert.equal(isYouTubeUrl('https://youtube.com.example.org/watch?v=abcdefghijk'), false);
});

test('resolver handles YouTube URLs, text searches, and direct media URLs', async () => {
  const calls = [];
  const execute = async (url, options, executionOptions) => {
    calls.push({ url, options, executionOptions });
    if (url.startsWith('ytsearch1:')) return { entries: [{ id: videoId }] };
    return { url: 'https://media.example/audio.webm', title: 'A song', duration: 42 };
  };
  const youtubeResolver = new YouTubeResolver({ timeout: 1234, execute });
  const resolver = new SourceResolver({ youtubeResolver });

  const youtubeTrack = await resolver.resolve(`https://youtube.com/watch?v=${videoId}`);
  assert.deepEqual(youtubeTrack, {
    url: 'https://media.example/audio.webm',
    title: 'A song',
    duration: 42,
    headers: {},
    source: 'youtube'
  });
  assert.equal(calls[0].executionOptions.timeout, 1234);
  assert.equal(calls[0].options.dumpSingleJson, true);
  assert.equal(calls[0].options.format, 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best');

  const searchTrack = await resolver.resolve('  a query; $(echo unsafe)  ');
  assert.equal(calls[1].url, 'ytsearch1:a query; $(echo unsafe)');
  assert.equal(searchTrack.source, 'youtube');
  assert.deepEqual(await resolver.resolve('https://media.example/song.mp3'), {
    url: 'https://media.example/song.mp3',
    title: 'media.example',
    duration: null,
    source: 'direct'
  });
});

test('resolver validates searches and maps yt-dlp failures', async () => {
  const unavailable = new YouTubeResolver({
    execute: async () => { throw new Error('This video is unavailable'); }
  });
  await assert.rejects(unavailable.resolveVideoId(videoId), UserInputError);
  await assert.rejects(unavailable.search(''), UserInputError);
  await assert.rejects(new YouTubeResolver({
    execute: async () => { throw new Error('Command timed out'); }
  }).resolveVideoId(videoId), (error) => error instanceof AudioSourceError && error.message.includes('too long'));
});

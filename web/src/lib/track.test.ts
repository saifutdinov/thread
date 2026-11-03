import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSpotifyTrack, isTrack, trackInfo, trackMime } from './track.ts';

test('a file with audio inside is a track; a voice message or a document is not', () => {
  assert.equal(isTrack({ t: 'file', m: 'audio/mpeg', n: 'a.mp3' }), true);
  assert.equal(isTrack({ t: 'file', m: 'application/octet-stream', n: 'Song.FLAC' }), true); // no type from the browser
  assert.equal(isTrack({ t: 'file', m: 'application/pdf', n: 'a.pdf' }), false);
  assert.equal(isTrack({ t: 'voice', m: 'audio/webm' }), false);
  assert.equal(isTrack({ m: 'image/jpeg' }), false);
  assert.equal(isTrack({ t: 'file', m: '', n: 'x.constructor' }), false);
});

test('title and artist come from the tags, or from an "Artist - Title" file name', () => {
  assert.deepEqual(trackInfo({ m: 'audio/mp4', n: 'x.m4a', ti: 'Song', ar: 'Band' }), { title: 'Song', artist: 'Band' });
  assert.deepEqual(trackInfo({ m: 'audio/mpeg', n: 'Band - Song - Live.mp3' }), { title: 'Song - Live', artist: 'Band' });
  assert.deepEqual(trackInfo({ m: 'audio/mpeg', n: 'song.mp3' }), { title: 'song', artist: '' });
  assert.deepEqual(trackInfo({ m: 'audio/mpeg' }), { title: '', artist: '' });
});

test('a track plays with an audio type only, whatever the sender wrote', () => {
  assert.equal(trackMime({ m: 'audio/mp4', n: 'a.m4a' }), 'audio/mp4');
  assert.equal(trackMime({ m: 'application/octet-stream', n: 'a.flac' }), 'audio/flac');
  assert.equal(trackMime({ m: 'text/html', n: 'a.mp3' }), 'audio/mpeg');
  assert.equal(trackMime({ m: 'audio/x-m4a; codecs=mp4a', n: 'a' }), 'audio/x-m4a');
});

test('only Spotify track links go to the server (music.go has the same check)', () => {
  assert.equal(isSpotifyTrack('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=1'), true);
  assert.equal(isSpotifyTrack(' https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC '), true);
  assert.equal(isSpotifyTrack('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), true);
  assert.equal(isSpotifyTrack('https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC'), false);
  assert.equal(isSpotifyTrack('https://open.spotify.com.evil.example/track/4uLU6hMCjMI75M1A2tKUQC'), false);
});

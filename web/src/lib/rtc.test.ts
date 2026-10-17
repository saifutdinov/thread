import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preferCodecs, rate, tuneOpus, videoOrder } from './rtc.ts';

const SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1',
  'a=rtpmap:63 red/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
  '',
].join('\r\n');

test('tuneOpus asks for FEC, no DTX and 48 kbit/s, keeping other params', () => {
  const out = tuneOpus(SDP);
  const fmtp = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111 '))!;
  const params = new Map(fmtp.slice('a=fmtp:111 '.length).split(';').map((p) => p.split('=') as [string, string]));
  assert.equal(params.get('minptime'), '10');
  assert.equal(params.get('useinbandfec'), '1');
  assert.equal(params.get('usedtx'), '0');
  assert.equal(params.get('maxaveragebitrate'), '48000');
  assert.ok(out.includes('a=rtpmap:96 VP8/90000\r\n'), 'video untouched, CRLF kept');
});

test('tuneOpus adds an fmtp line when there is none, and leaves SDP without Opus alone', () => {
  const bare = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n', '');
  assert.match(tuneOpus(bare), /a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 [^\r\n]*maxaveragebitrate=48000/);
  const noOpus = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
  assert.equal(tuneOpus(noOpus), noOpus);
});

test('preferCodecs moves preferred codecs first and keeps the rest in order', () => {
  const caps = ['video/VP8', 'video/rtx', 'video/VP9', 'video/H264', 'video/red'].map((mimeType) => ({ mimeType }));
  assert.deepEqual(
    preferCodecs(caps, ['video/h264', 'video/vp9']).map((c) => c.mimeType),
    ['video/H264', 'video/VP9', 'video/VP8', 'video/rtx', 'video/red'],
  );
});

test('videoOrder: H.264 on Apple (hardware), VP8 on Android, VP9 on desktops', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const macChrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  assert.deepEqual(videoOrder(iphone), { order: ['video/h264', 'video/vp8', 'video/vp9'], mobile: true });
  assert.deepEqual(videoOrder(macSafari).order[0], 'video/h264');
  assert.deepEqual(videoOrder(macChrome), { order: ['video/vp9', 'video/vp8', 'video/h264'], mobile: false });
  assert.deepEqual(videoOrder(android), { order: ['video/vp8', 'video/h264', 'video/vp9'], mobile: true });
});

test('rate turns round-trip time and loss into a level', () => {
  assert.equal(rate(40, 0), 'good');
  assert.equal(rate(300, 0.5), 'fair');
  assert.equal(rate(80, 3), 'fair');
  assert.equal(rate(500, 0), 'poor');
  assert.equal(rate(90, 8), 'poor');
  assert.equal(rate(undefined, undefined), 'good'); // nothing measured yet
});

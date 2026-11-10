import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripJpeg } from './image.ts';

const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
// EXIF with orientation 6 (little-endian TIFF), and a fake GPS string after it.
const exif = (o: number) =>
  seg(0xe1, [...ascii('Exif\0\0'), 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0, ...ascii('GPS 55.75N 37.61E')]);
const jfif = seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const icc = seg(0xe2, [...ascii('ICC_PROFILE\0'), 1, 1, 9, 9]);
const mpf = seg(0xe2, [...ascii('MPF\0'), 7, 7]);
const dqt = seg(0xdb, [0, 1, 2, 3]);
const sos = seg(0xda, [1, 1, 0, 0, 63, 0]);
const scan = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56]; // stuffed FF and a restart marker
const eoi = [0xff, 0xd9];

const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s));

test('HD keeps the pixels and drops place, comments and appended pictures', () => {
  const src = new Uint8Array([0xff, 0xd8, ...jfif, ...exif(6), ...icc, ...mpf, ...seg(0xfe, ascii('a comment')), ...dqt, ...sos, ...scan, ...eoi, ...ascii('depth map after the image')]);
  const out = stripJpeg(src)!;
  assert.ok(out);
  assert.ok(!has(out, 'GPS') && !has(out, 'comment') && !has(out, 'MPF') && !has(out, 'depth map'));
  assert.ok(has(out, 'JFIF') && has(out, 'ICC_PROFILE'), 'JFIF and the colour profile stay');
  // The image data, byte for byte.
  assert.ok(Buffer.from(out).includes(Buffer.from([...dqt, ...sos, ...scan, ...eoi])));
  assert.deepEqual([...out.subarray(out.length - 2)], eoi);
  // Orientation 6 kept in a minimal EXIF right after JFIF.
  const at = 2 + jfif.length;
  assert.deepEqual([...out.subarray(at, at + 2)], [0xff, 0xe1]);
  assert.ok(has(out, 'Exif\0\0MM'));
  assert.equal(out[at + 4 + 6 + 19], 6);
});

test('an upright photo needs no EXIF at all, and anything unreadable is re-encoded', () => {
  const upright = stripJpeg(new Uint8Array([0xff, 0xd8, ...exif(1), ...dqt, ...sos, ...scan, ...eoi]))!;
  assert.ok(!has(upright, 'Exif'));
  assert.equal(stripJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null, 'not a JPEG');
  assert.equal(stripJpeg(new Uint8Array([0xff, 0xd8, ...dqt, ...sos, ...scan])), null, 'no end');
  assert.equal(stripJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x40, 1])), null, 'cut short');
});

test('fill bytes, an Adobe colour segment and a JFIF thumbnail', () => {
  const thumbJfif = seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 2, 1, 9, 9, 9, 9, 9, 9]); // a 2x1 thumbnail
  const adobe = seg(0xee, [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1]);
  const src = new Uint8Array([0xff, 0xd8, ...thumbJfif, 0xff, ...exif(1), ...adobe, ...dqt, ...sos, ...scan, ...eoi]);
  const out = stripJpeg(src)!;
  assert.ok(out, 'a fill byte before a marker is read past');
  assert.ok(!has(out, 'GPS'));
  assert.ok(has(out, 'Adobe'), 'the colour transform stays');
  // JFIF kept as its 14-byte header, the thumbnail gone.
  assert.deepEqual([...out.subarray(2, 6)], [0xff, 0xe0, 0, 16]);
  assert.deepEqual([...out.subarray(18, 20)], [0, 0]);
  assert.ok(!Buffer.from(out).includes(Buffer.from([9, 9, 9, 9, 9, 9])));
});

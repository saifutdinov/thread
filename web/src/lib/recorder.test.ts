import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dragAction, fmtDuration, fmtSize, waveform } from './recorder.ts';

test('waveform has fixed bars scaled to 0..31', () => {
  const w = waveform(Array.from({ length: 300 }, (_, i) => (i % 50) / 50), 48);
  assert.equal(w.length, 48);
  assert.ok(w.every((v) => Number.isInteger(v) && v >= 0 && v <= 31));
  assert.equal(Math.max(...w), 31); // loudest bar always fills the height
});

test('waveform survives silence and very short recordings', () => {
  assert.deepEqual(waveform([], 8), new Array(8).fill(0));
  assert.equal(waveform([0.5], 8).length, 8);
  assert.ok(waveform([0, 0, 0], 4).every((v) => v === 0));
});

test('durations and sizes read like Telegram', () => {
  assert.equal(fmtDuration(0), '0:00');
  assert.equal(fmtDuration(7400), '0:07');
  assert.equal(fmtDuration(65_000), '1:05');
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(2048), '2 KB');
  assert.equal(fmtSize(5 * 1024 * 1024), '5.0 MB');
});

test('a held record button locks when dragged up and cancels when dragged left', () => {
  assert.equal(dragAction(0, 0), null);
  assert.equal(dragAction(-10, -30), null); // a wobbly thumb is still a hold
  assert.equal(dragAction(5, -90), 'lock');
  assert.equal(dragAction(-130, 10), 'cancel');
  assert.equal(dragAction(-130, -90), 'cancel'); // mostly sideways: the larger move wins
  assert.equal(dragAction(-90, -130), 'lock');
  assert.equal(dragAction(200, 0), null); // right is nowhere
});

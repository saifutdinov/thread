import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDoubleTap, placeTile, tileWidth } from './tap.ts';

test('two quick taps in one place are a double tap', () => {
  assert.equal(isDoubleTap(null, { t: 0, x: 10, y: 10 }), false); // the first tap
  assert.equal(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 250, x: 14, y: 12 }), true);
  assert.equal(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 450, x: 10, y: 10 }), false); // too slow
  assert.equal(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 200, x: 80, y: 10 }), false); // somewhere else
});

test('a small tile is wider for a landscape picture, and never taller than 40% of the screen', () => {
  assert.equal(tileWidth(720, 1280), 'min(8rem, 28vw, calc(40vh * 720 / 1280))');
  assert.equal(tileWidth(1280, 720), 'min(12rem, 40vw, calc(40vh * 1280 / 720))');
  assert.equal(tileWidth(0, 0), 'min(8rem, 28vw)'); // no picture yet
});

test('a dragged tile lands as fractions of its room and stays inside it', () => {
  const room = { w: 968, h: 608 };
  const tile = { w: 200, h: 150 };
  assert.deepEqual(placeTile(room, tile, 0, 0), [0, 0]);
  assert.deepEqual(placeTile(room, tile, 768, 458), [1, 1]);
  assert.deepEqual(placeTile(room, tile, 384, 229), [0.5, 0.5]);
  assert.deepEqual(placeTile(room, tile, -500, 5000), [0, 1], 'dragged past the edge: at the edge');
  assert.deepEqual(placeTile({ w: 180, h: 100 }, tile, 50, 50), [0, 0], 'no room to move: at the start');
});

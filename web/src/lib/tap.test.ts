import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDoubleTap, tileWidth } from './tap.ts';

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

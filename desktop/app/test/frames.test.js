import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Frames, frame } from '../lib/frames.js';

test('native messages are a little-endian length and JSON, whole or in pieces', () => {
  const a = frame({ type: 'ready', version: 1 });
  assert.equal(a.readUInt32LE(0), a.length - 4);
  const f = new Frames();
  const both = Buffer.concat([a, frame({ type: 'state', down: true, session: 's' })]);
  assert.deepEqual(f.push(both.subarray(0, 7)), []);
  assert.deepEqual(f.push(both.subarray(7)), [{ type: 'ready', version: 1 }, { type: 'state', down: true, session: 's' }]);
});

test('an oversized or broken frame stops the reader', () => {
  const f = new Frames();
  const big = Buffer.alloc(4);
  big.writeUInt32LE(1 << 20);
  assert.throws(() => f.push(big));
  const bad = Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from('{x')]);
  assert.throws(() => new Frames().push(bad));
});

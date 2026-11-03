import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hold } from './hold.ts';
test('hold release, overlapping inputs, and focus loss always leave microphone muted', () => {
  const changes: boolean[] = [];
  const h = new Hold((v) => changes.push(v));
  h.set('key', true);
  h.set('key', true);
  h.set('pointer', true);
  h.set('key', false);
  h.set('pointer', false);
  h.set('key', true);
  h.reset();
  h.set('key', false);
  assert.deepEqual(changes, [true, false, true, false]);
});

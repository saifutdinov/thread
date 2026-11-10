import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, CONNECT_MS, DEAD_AFTER_MS, PING_AFTER_MS } from './liveness.ts';

const at = 1_000_000;
const open = (lastIn: number, pingAt = 0) => ({ open: true, startedAt: 0, lastIn, pingAt });

test('a socket that hears events is left alone', () => {
  assert.equal(check(at, open(at - 1000)), 'wait');
});

test('a silent socket is asked, and one that stays silent is gone', () => {
  assert.equal(check(at, open(at - PING_AFTER_MS)), 'ping');
  assert.equal(check(at, open(at - 20_000, at - 3000)), 'wait', 'the answer may still be on its way');
  assert.equal(check(at, open(at - 20_000, at - DEAD_AFTER_MS)), 'dead');
});

test('an answer after the question keeps the socket', () => {
  assert.equal(check(at, open(at - 2000, at - 2100)), 'wait');
});

test('a hidden tab ticks once a minute: a late tick is no reason to drop a live socket', () => {
  // The last ping was answered a minute ago; the tick ran late, not the socket.
  assert.equal(check(at, open(at - 59_000, at - 59_100)), 'ping');
});

test('a connection that never opens is given up', () => {
  assert.equal(check(at, { open: false, startedAt: at - 5000, lastIn: 0, pingAt: 0 }), 'wait');
  assert.equal(check(at, { open: false, startedAt: at - CONNECT_MS, lastIn: 0, pingAt: 0 }), 'dead');
});

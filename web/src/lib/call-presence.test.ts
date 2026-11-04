import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallPresence } from './call-presence.ts';

test('participant chimes ignore snapshots, duplicate events and additional devices of one person', () => {
  const sounds: string[] = [];
  const p = new CallPresence((kind) => sounds.push(kind));
  p.joined('2.1.a');
  p.start(['2.1.a'], '1.1.self');
  p.joined('2.1.a');
  p.joined('2.2.b');
  p.joined('1.2.mine');
  assert.deepEqual(sounds, []);
  p.joined('3.1.c');
  p.joined('3.1.c');
  p.left('2.1.a');
  p.left('unknown');
  assert.deepEqual(sounds, ['join']);
  p.left('2.2.b');
  p.left('2.2.b');
  p.left('1.2.mine');
  assert.deepEqual(sounds, ['join', 'leave']);
});

test('reconnection rebaselines silently before new membership changes', () => {
  const sounds: string[] = [];
  const p = new CallPresence((kind) => sounds.push(kind));
  p.start(['2.1.a'], '1.1.self');
  p.pause();
  p.left('2.1.a');
  p.joined('3.1.b');
  p.start(['2.1.new', '3.1.b'], '1.1.self');
  p.joined('2.1.new');
  p.joined('3.1.b');
  assert.deepEqual(sounds, []);
  p.left('3.1.b');
  p.joined('4.1.c');
  assert.deepEqual(sounds, ['leave', 'join']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Talk } from '../lib/talk.js';

function rig() {
  let now = 0;
  const sent = [];
  const page = [];
  const hosts = [];
  const talk = new Talk({
    clock: () => now,
    toPage: (m) => page.push(m),
    start: () => {
      const host = { sent: [], stopped: false, send: (m) => host.sent.push(m), stop: () => (host.stopped = true) };
      hosts.push(host);
      return host;
    },
  });
  return { talk, page, hosts, sent, tick: (ms) => (now += ms) };
}
const key = { code: 'F8', ctrl: false, alt: false, shift: false, meta: false };

test('the page hears the key only after the companion says it speaks version 1', () => {
  const r = rig();
  r.talk.fromPage({ type: 'configure', binding: key, enabled: true, connect: true, session: 's1' });
  assert.deepEqual(r.hosts[0].sent, [{ type: 'configure', binding: key, enabled: true, session: 's1' }]);
  r.talk.fromHost({ type: 'state', down: true, session: 's1' });
  assert.deepEqual(r.page, [], 'nothing before ready');
  r.talk.fromHost({ type: 'ready', version: 1 });
  r.talk.fromHost({ type: 'state', down: true, session: 's1' });
  assert.deepEqual(r.page.at(-1), { type: 'state', down: true, session: 's1', status: 'ready' });
});

test('a companion of another version is stopped', () => {
  const r = rig();
  r.talk.fromPage({ type: 'configure', binding: key, enabled: true, connect: true, session: 's1' });
  r.talk.fromHost({ type: 'ready', version: 2 });
  assert.equal(r.hosts[0].stopped, true);
});

test('a page cannot scan keys: a second binding within a second stops the companion', () => {
  const r = rig();
  r.talk.fromPage({ type: 'configure', binding: key, enabled: true, connect: true, session: 's1' });
  r.tick(200);
  r.talk.fromPage({ type: 'configure', binding: { ...key, code: 'F9' }, enabled: true, connect: true, session: 's1' });
  assert.equal(r.hosts[0].stopped, true);
  assert.equal(r.page.at(-1).status, 'error');
  r.tick(1000);
  r.talk.fromPage({ type: 'configure', binding: { ...key, code: 'F9' }, enabled: true, connect: true, session: 's1' });
  assert.equal(r.hosts.length, 2, 'after a pause it may change');
});

test('a malformed request changes nothing, and a lost companion releases the key', () => {
  const r = rig();
  r.talk.fromPage({ type: 'configure', binding: key, enabled: true, connect: true, session: 'x'.repeat(65) });
  assert.equal(r.hosts.length, 0);
  r.talk.fromPage({ type: 'configure', binding: key, enabled: true, connect: true, session: 's1' });
  r.talk.hostGone();
  assert.deepEqual(r.page.at(-1), { type: 'state', down: false, status: 'error' });
});

test('turning it off stops the companion and says it is still there to use', () => {
  const r = rig();
  r.talk.fromPage({ type: 'configure', binding: key, enabled: true, connect: true, session: 's1' });
  r.talk.fromPage({ type: 'configure', binding: key, enabled: false, connect: false, session: 's1' });
  assert.equal(r.hosts[0].stopped, true);
  assert.deepEqual(r.page.at(-1), { type: 'state', down: false, status: 'available' });
});

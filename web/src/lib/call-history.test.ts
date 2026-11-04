import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallHistory, type CallEvent, beginDiagnostics, clearDiagnostics, lastDiagnostics } from './diagnostics.ts';

test('call history is bounded, detached and drops unknown fields and event names', () => {
  let time = 0;
  const h = new CallHistory(() => time);
  h.mark('starting');
  time = 121_000;
  for (let i = 0; i < 200; i++) h.mark('quality-poor', { rtt: 500, lossPct: NaN, address: 'private' } as never);
  h.mark('private SDP' as CallEvent);
  const rows = h.snapshot();
  assert.equal(rows.length, 180);
  assert.deepEqual(rows[0], { at: 121_000, event: 'quality-poor', rtt: 500 });
  rows[0].rtt = 1;
  assert.equal(h.snapshot()[0].rtt, 500);
});

test('a late previous call or logout cannot overwrite the latest finished diagnostics', async () => {
  let resolve!: (v: RTCStatsReport[]) => void;
  const old = beginDiagnostics('direct');
  old.mark('reconnecting');
  old.finish(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const next = beginDiagnostics('group');
  next.mark('connected');
  next.finish(Promise.resolve([]));
  await new Promise((r) => setImmediate(r));
  resolve([]);
  await new Promise((r) => setImmediate(r));
  assert.equal(lastDiagnostics.value?.kind, 'group');
  assert.deepEqual(
    lastDiagnostics.value?.history.map((e) => e.event),
    ['connected', 'ended'],
  );
  const after = beginDiagnostics('direct');
  after.finish(Promise.resolve([]));
  clearDiagnostics();
  await new Promise((r) => setImmediate(r));
  assert.equal(lastDiagnostics.value, null);
});

test('an idle ongoing call does not export events older than two minutes', () => {
  let time = 0;
  const h = new CallHistory(() => time);
  h.mark('connected');
  time = 120_001;
  assert.deepEqual(h.snapshot(), []);
});

test('finished history stays downloadable when RTC statistics never settle', () => {
  const h = beginDiagnostics('direct');
  h.mark('disconnected');
  h.finish(new Promise(() => {}));
  assert.deepEqual(lastDiagnostics.value?.history.map((e) => e.event), ['disconnected', 'ended']);
  clearDiagnostics();
  h.finish(Promise.resolve([]));
  assert.equal(lastDiagnostics.value, null, 'a late finish after logout must stay cleared');
});

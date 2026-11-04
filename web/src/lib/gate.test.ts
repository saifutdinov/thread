import assert from 'node:assert/strict';
import test from 'node:test';

// The worklet runs on the audio thread; here its globals are stand-ins.
type Gate = {
  process(i: Float32Array[][], o: Float32Array[][], p: { threshold: Float32Array; hold: Float32Array; gainDb: Float32Array }): boolean;
  port: { onmessage: (e: { data: unknown }) => void; postMessage: (v: unknown) => void };
};
let Processor: new () => Gate;
const g = globalThis as Record<string, unknown>;
g.sampleRate = 48000;
g.AudioWorkletProcessor = class {
  port = { onmessage: (_: { data: unknown }) => {}, postMessage: (_: unknown) => {} };
};
g.registerProcessor = (_: string, c: new () => Gate) => (Processor = c);
await import('./gate-worklet.js');

const block = (amp: number) => Float32Array.from({ length: 128 }, (_, i) => amp * Math.sin(i / 5));
// run feeds n blocks at amplitude amp and returns the last output's peak.
function run(gate: Gate, amp: number, n: number, threshold: number, hold = 0.3, gainDb = 0) {
  let out = new Float32Array(128);
  for (let i = 0; i < n; i++) {
    out = new Float32Array(128);
    gate.process([[block(amp)]], [[out]], { threshold: Float32Array.of(threshold), hold: Float32Array.of(hold), gainDb: Float32Array.of(gainDb) });
  }
  return Math.max(...out.map(Math.abs));
}

test('off: everything passes', () => {
  const gate = new Processor();
  assert.ok(run(gate, 0.001, 200, -100) > 0.0009);
});

test('quiet sound under the threshold fades out after the hold', () => {
  const gate = new Processor();
  assert.ok(run(gate, 0.3, 10, -40) > 0.29, 'a voice passes');
  assert.ok(run(gate, 0.001, 20, -40) > 0.0009, 'a short pause is held open');
  assert.equal(run(gate, 0.001, 400, -40), 0, 'silence after the hold is cut');
  assert.ok(run(gate, 0.3, 10, -40) > 0.29, 'the next word opens it again');
});

test('the threshold changes live', () => {
  const gate = new Processor();
  assert.equal(run(gate, 0.01, 400, -30), 0);
  assert.ok(run(gate, 0.01, 10, -60) > 0.009);
});

test('the level goes to the meter only while watched', () => {
  const gate = new Processor();
  const got: unknown[] = [];
  gate.port.postMessage = (v) => got.push(v);
  run(gate, 0.1, 16, -100);
  assert.equal(got.length, 0);
  gate.port.onmessage({ data: true });
  run(gate, 0.1, 16, -100);
  assert.equal(got.length, 2);
  assert.ok(Math.abs((got[0] as number) + 23) < 1, 'about -23 dB for a 0.1 sine');
});

test('gain changes the sent signal and limits peaks; zero hold still passes speech', () => {
  const gate = new Processor();
  assert.ok(run(gate, 0.1, 20, -40, 0, 6) > 0.19);
  assert.equal(run(gate, 0.5, 20, -40, 0, 12), 1);
  assert.equal(run(gate, 0.001, 300, -40, 0, 12), 0);
});

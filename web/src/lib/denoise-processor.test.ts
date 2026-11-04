import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { FrameBuffer } from './denoise-frame.js';

function processor(cost: number, throws = false) {
  let clock = 0;
  const messages: { type: string; reason?: string }[] = [];
  const context = vm.createContext({ FrameBuffer, sampleRate: 48000, Date: { now: () => clock },
    AudioWorkletProcessor: class { port = { postMessage: (m: { type: string }) => messages.push(m) }; },
  });
  const source = readFileSync(new URL('./denoise-processor.js', import.meta.url), 'utf8').replace(/^import.*\n/, '').replace('export class', 'class');
  vm.runInContext(source + '\nglobalThis.Processor=DenoiseProcessor;', context);
  const p = new context.Processor({ processorOptions: { strength: 1 } }, 'deepfilter');
  p.ready = true;
  p.engine = { process(frame: Float32Array) { clock += cost; if (throws) throw new Error('model'); return frame; } };
  const input = new Float32Array(128).fill(0.2), output = new Float32Array(128);
  const render = () => p.process([[input]], [[output]]);
  return { p, messages, input, output, render };
}

test('a model exception immediately passes raw audio and reports failure only once', () => {
  const h = processor(0, true);
  for (let i = 0; i < 5; i++) h.render();
  assert.equal(h.p.ready, false);
  assert.deepEqual(h.output, h.input);
  assert.equal(h.messages.filter((m) => m.type === 'error').length, 1);
});

test('sustained inference overruns bypass after warmup while fast frames stay processed', () => {
  for (const cost of [0.5, 4]) {
    const h = processor(cost);
    for (let i = 0; i < 400; i++) h.render();
    assert.equal(h.p.failed, cost === 4);
    assert.equal(h.messages.some((m) => m.reason === 'overload'), cost === 4);
    assert.ok(h.output.every((value) => Number.isFinite(value) && value > 0));
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameBuffer } from './denoise-frame.js';

test('128-sample callbacks preserve sample order and align RNNoise dry/wet latency', () => {
  const input = Float32Array.from({ length: 128 * 60 }, (_, i) => Math.sin(i / 19) * 0.2);
  for (const strength of [0, 0.5, 1]) {
    const adapter = new FrameBuffer('rnnoise');
    const previous = new Float32Array(960);
    const output = new Float32Array(input.length);
    const engine = (frame: Float32Array) => {
      const next = frame.slice();
      frame.set(previous.subarray(0, 480));
      previous.copyWithin(0, 480);
      previous.set(next, 480);
      for (let i = 0; i < frame.length; i++) frame[i] *= 0.5;
    };
    for (let i = 0; i < input.length; i += 128) adapter.render(input.subarray(i, i + 128), output.subarray(i, i + 128), engine, strength);
    const dry = strength === 0 ? 1 : strength === 1 ? 0 : 0.1;
    for (let i = 0; i < output.length; i++) {
      const want = i < 1440 ? 0 : input[i - 1440] * (dry + (1 - dry) * 0.5);
      assert.ok(Math.abs(output[i] - want) < 1e-6, `sample ${i}, strength ${strength}`);
    }
  }
});

test('DeepFilter attenuation stays in the model instead of mixing unaligned dry audio', () => {
  const adapter = new FrameBuffer('deepfilter');
  const output = new Float32Array(960);
  adapter.render(new Float32Array(960).fill(0.5), output, (frame: Float32Array) => frame.fill(0.1), 0.5);
  assert.equal(output[479], 0);
  assert.ok(Math.abs(output[480] - 0.1) < 1e-6);
});

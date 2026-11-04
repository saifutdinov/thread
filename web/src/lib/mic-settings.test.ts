import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMicSettings } from './mic-settings.ts';

test('migrates the old noise switch and threshold without enabling DeepFilterNet', () => {
  assert.equal(readMicSettings('', { denoise: '1', gate: '-42' }, false).model, 'rnnoise');
  assert.equal(readMicSettings('', { denoise: '0', gate: '-42' }, true).model, 'browser');
  assert.equal(readMicSettings('', { denoise: '', gate: '-42' }, true).gate, -42);
  assert.equal(readMicSettings('', { denoise: '', gate: '' }, false).model, 'browser');
});

test('corrupt or out-of-range preferences cannot produce NaN or excessive gain', () => {
  const legacy = { denoise: '', gate: '' };
  assert.equal(readMicSettings('{', legacy, true).model, 'rnnoise');
  const settings = readMicSettings(JSON.stringify({ model: '__proto__', strength: 3, gain: 100, hold: -2, gate: -200, agc: 'false' }), legacy, false);
  assert.equal(settings.model, 'browser');
  assert.equal(settings.strength, 1);
  assert.equal(settings.gain, 12);
  assert.equal(settings.hold, 0);
  assert.equal(settings.gate, -70);
  assert.equal(settings.agc, true);
  assert.equal(readMicSettings('null', legacy, true).model, 'rnnoise');
});

test('restores the chosen model and explicit zero and false values', () => {
  const settings = readMicSettings(JSON.stringify({ model: 'deepfilter', strength: 0, gain: 0, hold: 0, agc: false, echo: false, highPass: false }), { denoise: '0', gate: '' }, true);
  assert.equal(settings.model, 'deepfilter');
  assert.equal(settings.strength, 0);
  assert.equal(settings.hold, 0);
  assert.equal(settings.agc, false);
  assert.equal(settings.echo, false);
});

test('RNNoise is the capable-desktop default while saved and legacy choices win', () => {
  const legacy = { denoise: '', gate: '' };
  assert.equal(readMicSettings('', legacy, true).model, 'rnnoise');
  assert.equal(readMicSettings('', legacy, false).model, 'browser');
  assert.equal(readMicSettings('{"model":"off"}', legacy, true).model, 'off');
  assert.equal(readMicSettings('', { denoise: '0', gate: '' }, true).model, 'browser');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetworkPolicy, videoBudget } from './network-policy.ts';

test('automatic economy requires sustained degradation and slower uninterrupted recovery', () => {
  const p = new NetworkPolicy();
  assert.equal(p.observe('auto', 'poor', 0), false);
  assert.equal(p.observe('auto', 'poor', 7999), false);
  assert.equal(p.observe('auto', 'poor', 8000), true);
  assert.equal(p.observe('auto', 'good', 9000), true);
  assert.equal(p.observe('auto', 'fair', 30_000), true);
  assert.equal(p.observe('auto', 'good', 31_000), true);
  assert.equal(p.observe('auto', 'good', 60_999), true);
  assert.equal(p.observe('auto', 'good', 61_000), false);
});

test('manual economy and normal apply immediately; a new call and unknown samples reset recovery timers', () => {
  const p = new NetworkPolicy();
  assert.equal(p.observe('economy'), true);
  assert.equal(p.observe('normal'), false);
  assert.equal(p.observe('economy'), true);
  assert.equal(p.observe('auto', 'good', 0), true);
  assert.equal(p.observe('auto', undefined, 40_000), true);
  assert.equal(p.observe('auto', 'good', 50_000), true);
  assert.equal(p.observe('auto', 'good', 79_999), true);
  p.reset();
  assert.equal(p.observe('auto', 'poor', 90_000), false);
});

test('economy preserves screen resolution and reduces motion while camera video is downscaled', () => {
  assert.deepEqual(videoBudget(true), { maxBitrate: 350_000, maxFramerate: 12, scaleResolutionDownBy: 2 });
  assert.deepEqual(videoBudget(true, true), { maxBitrate: 800_000, maxFramerate: 8, scaleResolutionDownBy: 1 });
  assert.equal(videoBudget(false).maxBitrate, 2_500_000);
});

test('fair samples preserve an ongoing poor period but never count towards recovery', () => {
  const p = new NetworkPolicy();
  assert.equal(p.observe('auto', 'fair', 0), false);
  assert.equal(p.observe('auto', 'fair', 100_000), false);
  assert.equal(p.observe('auto', 'poor', 101_000), false);
  assert.equal(p.observe('auto', 'fair', 105_000), false);
  assert.equal(p.observe('auto', 'poor', 109_000), true);
  assert.equal(p.observe('auto', 'good', 110_000), true);
  assert.equal(p.observe('auto', 'fair', 139_000), true);
  assert.equal(p.observe('auto', 'good', 140_000), true);
  assert.equal(p.observe('auto', 'good', 169_999), true);
  assert.equal(p.observe('auto', 'good', 170_000), false);
});

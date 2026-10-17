import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scaleSteps } from './image.ts';

test('scaleSteps halves until the last step is under 2x', () => {
  // A 24 MP phone photo down to the 2560 px limit.
  assert.deepEqual(scaleSteps(5712, 4284, 2560, 1920), [
    [2856, 2142],
    [2560, 1920],
  ]);
  // An avatar: the middle square of a photo down to 256 px.
  assert.deepEqual(scaleSteps(4000, 4000, 256, 256), [
    [2000, 2000],
    [1000, 1000],
    [500, 500],
    [256, 256],
  ]);
});

test('scaleSteps draws once when there is little or nothing to shrink', () => {
  assert.deepEqual(scaleSteps(2560, 1920, 2560, 1920), [[2560, 1920]]);
  assert.deepEqual(scaleSteps(3000, 2000, 2560, 1707), [[2560, 1707]]);
  assert.deepEqual(scaleSteps(100, 100, 256, 256), [[256, 256]]); // a small picture grows
});

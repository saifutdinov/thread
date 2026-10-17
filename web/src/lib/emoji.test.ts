import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jumbo } from './emoji.ts';

test('jumbo counts short emoji-only messages', () => {
  for (const [text, want] of [
    ['😀', 1],
    [' 😀 👍 ', 2],
    ['🇷🇺', 1], // flag: two regional indicators, one grapheme
    ['👍🏽', 1], // skin tone
    ['👨‍👩‍👧', 1], // ZWJ family
    ['❤️❤️❤️', 3],
    ['😀😀😀😀', 0], // too many to blow up
    ['hi 😀', 0],
    ['12', 0], // digits are emoji components, not emoji
    ['**', 0],
    ['', 0],
  ] as const) {
    assert.equal(jumbo(text), want, JSON.stringify(text));
  }
});

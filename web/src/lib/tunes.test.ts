import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TUNE, length, repeats, TUNES } from './tunes.ts';

test('every kind has its default tune and a way to be silent', () => {
  for (const kind of ['ring', 'dial', 'message', 'join', 'leave'] as const) {
    assert.ok(TUNES[kind][DEFAULT_TUNE[kind]], `${kind}: no default`);
    assert.equal(TUNES[kind].off, null, `${kind}: no "off"`);
  }
});

test('repeating tunes fit their period, message sounds are short', () => {
  for (const kind of ['ring', 'dial', 'message', 'join', 'leave'] as const)
    for (const [id, tune] of Object.entries(TUNES[kind])) {
      if (!tune) continue;
      assert.ok(tune.notes.length > 0, `${kind}/${id}: no notes`);
      for (const n of tune.notes) assert.ok(n.f > 50 && n.f < 5000 && n.len > 0 && n.at >= 0, `${kind}/${id}: bad note`);
      if (!repeats(kind)) assert.ok(tune.every === 0 && length(tune) <= 1, `${kind}/${id}: a notification plays once and is short`);
      else assert.ok(tune.every > length(tune), `${kind}/${id}: overlaps its own repeat`);
    }
});

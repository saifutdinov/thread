import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { patchNotes } from './patch-notes.ts';

const number = (v: string) => v.slice(1).split('.').map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [number(a), number(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

test('releases are listed newest first, each once, with notes in both languages', () => {
  assert.ok(patchNotes.length > 0);
  patchNotes.forEach((note, i) => {
    assert.match(note.version, /^v\d+\.\d+\.\d+$/);
    assert.match(note.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(note.ru.length > 0, note.version);
    assert.equal(note.ru.length, note.en.length, note.version);
    if (i) assert.ok(newer(patchNotes[i - 1].version, note.version) > 0, note.version);
  });
});

const script = fileURLToPath(new URL('../../scripts/patch-notes.mjs', import.meta.url));
const run = (tag: string) => execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, tag], { encoding: 'utf8', stdio: 'pipe' });

test('a release gets its notes as text, in both languages', () => {
  const [note] = patchNotes;
  const text = run(note.version);
  assert.ok(text.includes(note.ru[0]) && text.includes(note.en[0]));
});

test('a tag without notes is refused, before anything is built', () => {
  assert.throws(() => run('v0.0.0'));
});

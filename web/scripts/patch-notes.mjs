// Prints the notes of a release, or fails: the text for a release on GitHub.
import { patchNotes } from '../src/lib/patch-notes.ts';

const tag = process.argv[2];
const note = patchNotes.find((n) => n.version === tag);
if (!note) {
  console.error(`No patch notes for ${tag}: add them to web/src/lib/patch-notes.ts`);
  process.exit(1);
}
const list = (lines) => lines.map((line) => `- ${line}`).join('\n');
console.log(`${list(note.ru)}\n\n${list(note.en)}`);

// Deliberately separate from the extension shipped to users.
import { cp, readFile, writeFile } from 'node:fs/promises';
const source = new URL('./extension/', import.meta.url);
const target = new URL('./.extension-dev/', import.meta.url);
await cp(source, target, { recursive: true });
const manifest = JSON.parse(await readFile(new URL('manifest.json', target), 'utf8'));
manifest.name = 'Thread push-to-talk (local development)';
manifest.content_scripts[0].matches.push('http://localhost/*');
await writeFile(new URL('manifest.json', target), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(
  new URL('origins.js', target),
  "globalThis.THREAD_PTT_ORIGINS = ['https://chat.example.org', 'http://localhost:8080', 'http://localhost:5173', 'http://localhost:8086'];\n",
);
console.log('Development extension: desktop/.extension-dev (never distribute this build)');

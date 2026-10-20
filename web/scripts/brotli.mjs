// Writes a brotli copy next to each WebAssembly file of the build. The
// proxies in front of the server compress text types only, and the face
// detector's engine is 13.5 MB; the server sends the .br copy to browsers
// that accept it (internal/server/server.go, static).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const dir = fileURLToPath(new URL('../dist/assets/', import.meta.url));
for (const f of readdirSync(dir).filter((n) => n.endsWith('.wasm'))) {
  const raw = readFileSync(join(dir, f));
  const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  writeFileSync(join(dir, f + '.br'), br);
  console.log(`brotli ${f}: ${(raw.length / 1e6).toFixed(1)} MB -> ${(br.length / 1e6).toFixed(1)} MB`);
}

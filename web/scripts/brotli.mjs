// Writes a brotli copy next to each big file of the build: the WebAssembly
// and the microphone worklets, one of which carries RNNoise (4.8 MB). The
// proxies in front of the server do not compress them; the server sends the
// .br copy to browsers that accept it (internal/server/server.go, static).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
for (const [folder, suffix] of [['assets', '.wasm'], ['audio', '.js']]) {
  const dir = join(dist, folder);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(suffix))) {
    const raw = readFileSync(join(dir, f));
    const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    writeFileSync(join(dir, f + '.br'), br);
    console.log(`brotli ${f}: ${(raw.length / 1e6).toFixed(1)} MB -> ${(br.length / 1e6).toFixed(1)} MB`);
  }
}

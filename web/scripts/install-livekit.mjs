// A pinned local test dependency, never installed into the application image.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.LIVEKIT_BINARY) {
  console.log(process.env.LIVEKIT_BINARY);
  process.exit(0);
}

const assets = {
  linux: ['livekit_1.13.10_linux_amd64.tar.gz', 'c25a3e45fb922e9a93c6443d10c0ed041ba64342097e38632331736630283165'],
  win32: ['livekit_1.13.10_windows_amd64.zip', 'fd4b7c2c3c1e4c71adaa4f6a046ad1c0abaaaf1e09fae904b35bf231ffae11d2'],
};
if (process.arch !== 'x64' || !assets[process.platform]) throw new Error('Set LIVEKIT_BINARY to LiveKit v1.13.10 on this platform.');
const [name, sha] = assets[process.platform];
const dir = fileURLToPath(new URL('../.call-test-tools/', import.meta.url));
await mkdir(dir, { recursive: true });
const archive = path.join(dir, name);
let bytes = await readFile(archive).catch(() => null);
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha) {
  const response = await fetch(`https://github.com/livekit/livekit/releases/download/v1.13.10/${name}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`LiveKit download: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('LiveKit archive checksum mismatch');
  await writeFile(archive, bytes);
}
execFileSync('tar', ['-xf', archive, '-C', dir], { windowsHide: true });
console.log(path.join(dir, process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server'));

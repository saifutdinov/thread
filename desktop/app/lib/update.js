import { createHash, createPublicKey, verify } from 'node:crypto';

// Updates from the app's own server (docs/updates.md). CI lists every
// installer with its version and SHA-256 in manifest.json and signs it with
// the owner's Ed25519 update key, which never touches the server. The app
// carries the public half (app-config.json updateKey) and installs nothing
// whose manifest that key did not sign: a broken server cannot hand it a
// program of its own.

// The installer this computer takes from a manifest's files, or null.
export function pick(files, platform, arch, appImage) {
  const want =
    platform === 'win32' ? 'windows'
    : platform === 'darwin' ? (arch === 'arm64' ? 'mac-arm' : 'mac-intel')
    : platform === 'linux' ? (appImage ? 'linux-appimage' : 'linux-deb')
    : '';
  return files.find((f) => f.platform === want) ?? null;
}

// newer: is version a (x.y.z) after b?
export function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

// The manifest, parsed, if the key signed exactly these bytes; else null.
// key: the raw 32-byte Ed25519 public key in base64 (openssl pkey -pubout,
// the last 32 bytes of the DER).
export function signed(manifestBytes, sigBase64, keyBase64) {
  try {
    const raw = Buffer.from(keyBase64, 'base64');
    if (raw.length !== 32) return null;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    if (!verify(null, manifestBytes, key, Buffer.from(String(sigBase64).trim(), 'base64'))) return null;
    const m = JSON.parse(manifestBytes.toString('utf8'));
    return Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// choose: the update for this computer, { file, trusted } or null. With an
// update key the manifest must be signed by it, or there is no update at
// all (not even one offered as a download: a server that lost or forged
// the signature could otherwise send people to its own program). Only an
// app built without a key takes the manifest as it is, and then only
// offers the file in the browser.
export function choose({ body, sig, key, platform, arch, appImage, current }) {
  let manifest;
  if (key) manifest = sig ? signed(body, sig, key) : null;
  else {
    try {
      manifest = JSON.parse(body.toString('utf8'));
    } catch {
      manifest = null;
    }
  }
  if (!manifest || !Array.isArray(manifest.files)) return null;
  const file = pick(manifest.files, platform, arch, appImage);
  if (!file || !newer(file.version, current)) return null;
  return { file, trusted: !!key };
}

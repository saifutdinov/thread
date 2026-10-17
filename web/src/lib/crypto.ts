// End-to-end encryption on WebCrypto only (docs/adr/0001-e2ee-webcrypto.md).
//
// Device keys: ECDH P-256 (key wrapping) + ECDSA P-256 (signatures), both
// generated non-extractable and kept as CryptoKey objects in IndexedDB:
// the private halves can never leave this browser.
// Chat keys: random AES-256-GCM per chat and epoch, wrapped per device
// with ECIES (ephemeral ECDH -> HKDF-SHA256 -> AES-GCM).

export type Bytes = Uint8Array<ArrayBuffer>;

const subtle = crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export const utf8 = (s: string): Bytes => te.encode(s) as Bytes;
export const fromUtf8 = (b: Bytes) => td.decode(b);

export function rand(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Standard base64 is what Go's encoding/json uses for []byte.
export function toB64(b: Bytes): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Bytes {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toB64u = (b: Bytes) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface DeviceKeys {
  enc: CryptoKeyPair;
  sig: CryptoKeyPair;
  encPub: Bytes;
  sigPub: Bytes;
}

export async function newDeviceKeys(): Promise<DeviceKeys> {
  const enc = (await subtle.generateKey(ECDH, false, ['deriveBits'])) as CryptoKeyPair;
  const sig = (await subtle.generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    enc,
    sig,
    encPub: new Uint8Array(await subtle.exportKey('raw', enc.publicKey)),
    sigPub: new Uint8Array(await subtle.exportKey('raw', sig.publicKey)),
  };
}

async function kek(priv: CryptoKey, pub: CryptoKey, salt: Bytes, usage: KeyUsage): Promise<CryptoKey> {
  const shared = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('connect/wrap/v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

// wrapKey -> ephemeral pub (65) || iv (12) || ciphertext+tag (48) = 125 bytes.
export async function wrapKey(raw: Bytes, recipientEncPub: Bytes, epoch: number): Promise<Bytes> {
  const pub = await subtle.importKey('raw', recipientEncPub, ECDH, false, []);
  const eph = (await subtle.generateKey(ECDH, false, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const iv = rand(12);
  const k = await kek(eph.privateKey, pub, ephPub, 'encrypt');
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(`k:${epoch}`) }, k, raw);
  return concat(ephPub, iv, new Uint8Array(ct));
}

export async function unwrapKey(wrapped: Bytes, encPriv: CryptoKey, epoch: number): Promise<Bytes> {
  const ephPub = wrapped.slice(0, 65);
  const pub = await subtle.importKey('raw', ephPub, ECDH, false, []);
  const k = await kek(encPriv, pub, ephPub, 'decrypt');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: wrapped.slice(65, 77), additionalData: utf8(`k:${epoch}`) },
    k,
    wrapped.slice(77),
  );
  return new Uint8Array(pt);
}

export const aesKey = (raw: Bytes) =>
  subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

// seal -> iv (12) || ciphertext. aad binds the blob to where it belongs.
export async function seal(key: CryptoKey, aad: string, data: Bytes): Promise<Bytes> {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, data);
  return concat(iv, new Uint8Array(ct));
}

export async function open(key: CryptoKey, aad: string, blob: Bytes): Promise<Bytes> {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: utf8(aad) },
    key,
    blob.slice(12),
  );
  return new Uint8Array(pt);
}

export async function sign(priv: CryptoKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.sign(SIGN, priv, data));
}

export async function verify(pubRaw: Bytes, sig: Bytes, data: Bytes): Promise<boolean> {
  try {
    const pub = await subtle.importKey('raw', pubRaw, ECDSA, false, ['verify']);
    return await subtle.verify(SIGN, pub, sig, data);
  } catch {
    return false;
  }
}

// Invite links carry a 32-byte secret in the URL fragment. The server only
// ever sees `auth` (and stores SHA-256 of it as the invite id); `wrap`
// encrypts the chat-key bundle and never leaves the browser.
export async function inviteKeys(secret: Bytes) {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) });
  const auth = new Uint8Array(await subtle.deriveBits(params('connect/invite/auth'), base, 256));
  const wrap = await subtle.deriveKey(params('connect/invite/wrap'), base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const id = new Uint8Array(await subtle.digest('SHA-256', auth));
  return { auth, wrap, id };
}

const CODE_EMOJI = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦉',
  '🐝', '🦋', '🐢', '🐙', '🐬', '🐳', '🌵', '🌲', '🌻', '🌹', '🍄', '🌙', '⭐', '🔥', '🌈', '❄️',
  '🍎', '🍋', '🍉', '🍇', '🍓', '🍒', '🥕', '🌽', '🍞', '🧀', '🍕', '🍩', '🎂', '☕', '⚽', '🏀',
  '🎸', '🎈', '🎁', '📚', '✏️', '🔑', '🔔', '⚓', '🚀', '🚲', '🚗', '⛵', '🏠', '⏰', '💡', '🎩',
];

export interface Code {
  emoji: string[];
  digits: string;
}

const sha256 = async (b: Bytes) => new Uint8Array(await subtle.digest('SHA-256', b));

// deviceCode is the short code both screens show when approving a device:
// four emoji (24 bits) plus the same bits as digits for screen readers.
export async function deviceCode(encPub: Bytes, sigPub: Bytes): Promise<Code> {
  const h = await sha256(concat(encPub, sigPub));
  const n = (h[0] << 16) | (h[1] << 8) | h[2];
  const emoji = [18, 12, 6, 0].map((s) => CODE_EMOJI[(n >> s) & 63]);
  const digits = String(n % 1000000).padStart(6, '0');
  return { emoji, digits: digits.slice(0, 3) + ' ' + digits.slice(3) };
}

// fingerprint identifies a person's current set of devices: it changes
// whenever a device is added or removed.
export async function fingerprint(devices: { enc_pub: string; sig_pub?: string }[]): Promise<Bytes> {
  const parts = devices.map((d) => toHex(concat(fromB64(d.enc_pub), fromB64(d.sig_pub ?? '')))).sort();
  return sha256(utf8(parts.join('|')));
}

// safetyCode is one code for a pair of people, identical on both sides
// (order does not matter), compared in person or over the phone.
export async function safetyCode(a: Bytes, b: Bytes): Promise<Code> {
  const [x, y] = [toHex(a), toHex(b)].sort();
  const h = await sha256(utf8(x + y));
  const emoji = [0, 1, 2, 3].map((i) => CODE_EMOJI[h[i] & 63]);
  let n = 0;
  for (let i = 4; i < 9; i++) n = n * 256 + h[i]; // 40 bits
  const d = String(n % 1e12).padStart(12, '0');
  return { emoji, digits: d.replace(/(\d{3})(?=\d)/g, '$1 ') };
}

export const toHex = (b: Bytes) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// PIN for the app lock: PBKDF2 so the stored hash resists casual guessing.
export async function pinHash(pin: string, salt: Bytes): Promise<Bytes> {
  const base = await subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 200_000 }, base, 256));
}

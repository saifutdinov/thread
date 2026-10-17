import { signal } from '@preact/signals';
import { fromB64, pinHash, rand, toB64, toB64u, type Bytes } from './crypto';
import { idbGet, idbSet } from './idb';

// App lock: a privacy screen for a shared or borrowed phone. It hides the
// app until the PIN or the device's biometrics answer; the encryption keys
// stay on the device either way (they cannot be wrapped: they are
// non-extractable by design).

export interface LockConf {
  salt: string;
  hash: string;
  cred?: string; // WebAuthn credential id, base64url
  timeout: number; // ms in the background before locking again
  hide: boolean; // generic push text instead of the message
}

export const lockConf = signal<LockConf | null>(null);
export const locked = signal(false);

let hiddenAt = 0;

export async function initLock() {
  lockConf.value = (await idbGet<LockConf>('lock')) ?? null;
  locked.value = !!lockConf.value;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (lockConf.value && Date.now() - hiddenAt >= lockConf.value.timeout) locked.value = true;
  });
}

async function save(conf: LockConf | null) {
  lockConf.value = conf;
  await idbSet('lock', conf ?? undefined);
  await idbSet('hidePreview', !!conf?.hide); // read by the service worker
}

export async function enableLock(pin: string) {
  const salt = rand(16);
  await save({ salt: toB64(salt), hash: toB64(await pinHash(pin, salt)), timeout: 60e3, hide: false });
}

export const disableLock = () => save(null);
export const updateLock = (patch: Partial<LockConf>) => lockConf.value && save({ ...lockConf.value, ...patch });

// Wrong PINs slow down: after 5 failures each try waits longer.
let failures = 0;
let blockedUntil = 0;
export const waitMs = () => Math.max(0, blockedUntil - Date.now());

export async function unlockPin(pin: string): Promise<boolean> {
  const conf = lockConf.value;
  if (!conf || waitMs() > 0) return false;
  const h = toB64(await pinHash(pin, fromB64(conf.salt)));
  if (h === conf.hash) {
    failures = 0;
    locked.value = false;
    return true;
  }
  failures++;
  if (failures >= 5) blockedUntil = Date.now() + 30e3 * 2 ** (failures - 5);
  return false;
}

export async function biometricsAvailable(): Promise<boolean> {
  try {
    return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

// Face ID / fingerprint through WebAuthn. Only the local gate uses it: the
// credential never reaches the server.
export async function enableBiometrics(name: string) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: rand(32),
      rp: { name: 'Thread' },
      user: { id: rand(16), name, displayName: name },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('webauthn');
  await updateLock({ cred: toB64u(new Uint8Array(cred.rawId) as Bytes) });
}

export async function unlockBiometric(): Promise<boolean> {
  const id = lockConf.value?.cred;
  if (!id) return false;
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: fromB64(id) }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    locked.value = false;
    return true;
  } catch {
    return false;
  }
}

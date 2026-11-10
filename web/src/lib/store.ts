import { batch, signal } from '@preact/signals';
import { clearDiagnostics } from './diagnostics';
import {
  api,
  ApiError,
  type DevicePub,
  type InviteInfo,
  type Me,
  type PendingDevice,
  type Member,
  type RawChat,
  type VaultKey,
  type RawMessage,
  type WrappedKey,
} from './api';
import {
  aesKey,
  type Bytes,
  type Code,
  concat,
  deviceCode,
  fingerprint,
  safetyCode,
  toHex,
  type DeviceKeys,
  fromB64,
  fromUtf8,
  inviteKeys,
  newDeviceKeys,
  open,
  rand,
  seal,
  sign,
  toB64,
  toB64u,
  unwrapKey,
  utf8,
  verify,
  wrapKey,
} from './crypto';
import { errText, t } from './i18n';
import { latest } from './latest';
import { latestMessage, mergeMessages as merge } from './messages';
import { MediaCache } from './media-cache';
import { fmtDuration } from './recorder';
import { idbClear, idbGet, idbSet } from './idb';
import { audioDuration, isTrack, trackInfo, trackMime } from './track';
import { prepareAvatar, prepareImage, prepareVideo, shrink } from './image';
import { plain } from './markup';
import { away, clear, notifyHere, notifyMessage } from './notify';
import { checkUpdate, nativeApp, mobile, pushOn, subscribe, unsubscribe } from './pwa';
import { messageSoundAllowed, playSound } from './sounds';
import { check, TICK_MS } from './liveness';
import { go, parse, replace, route } from './route';

// ---------- types ----------

// Attachment lives inside the encrypted payload. No `t` means a photo
// (messages from before voice, video and files existed).
export interface Attachment {
  id: string;
  k: string; // file key, base64url
  m: string; // mime
  s: number; // size, bytes
  t?: 'voice' | 'video' | 'clip' | 'file'; // video = round video message, clip = video from the gallery
  w?: number;
  h?: number;
  th?: string; // tiny preview, data URL
  d?: number; // duration, ms
  wf?: number[]; // voice waveform, 0..31
  n?: string; // file name
  ti?: string; // a track's title and artist, in tracks sent by the removed music by link
  ar?: string;
}

// Outgoing is something to attach before it is encrypted and uploaded.
export type Outgoing =
  | { kind: 'image'; file: File; hd?: boolean } // hd: the original pixels (image.ts prepareImage)
  | { kind: 'file'; file: File }
  | { kind: 'clip'; file: File }
  | { kind: 'voice'; blob: Blob; mime: string; d: number; wf: number[] }
  | { kind: 'video'; blob: Blob; mime: string; d: number; w: number; h: number; th: string };

// LocalFile previews an attachment while it uploads.
export interface LocalFile {
  kind: Outgoing['kind'];
  url: string;
  name?: string;
  d?: number;
}

// Payload is the plaintext inside a message's ciphertext.
export interface Payload {
  t?: string;
  a?: Attachment[];
  rp?: { id: number; n: string; t: string };
  fw?: { n: string }; // forwarded: original author's name
  cl?: CallLog; // a call happened (written by the caller)
  lp?: LinkCard; // link preview, built by the sender
}

// LinkCard is a link preview inside the encrypted payload: recipients
// render it as is and never fetch the page or the picture themselves.
export interface LinkCard {
  u: string;
  s?: string; // site
  t?: string; // title
  d?: string; // description
  i?: string; // picture, small JPEG data URL
}

export interface CallLog {
  v: boolean; // video
  d: number; // talk time, ms
  s: 'ok' | 'missed' | 'declined' | 'busy' | 'failed';
  g?: string; // a group call: its id (written by whoever started it, "ok" for older apps)
}

export interface Msg extends RawMessage {
  p?: Payload | null; // null: no key (yet) to decrypt
  bad?: boolean; // signature does not verify
  rx?: [string, number[]][]; // reactions: emoji -> user ids
  local?: 'sending' | 'failed';
  files?: LocalFile[]; // previews of local uploads
  retry?: () => void;
}

export interface Chat extends RawChat {
  titleText: string;
  lastMsg?: Msg;
  pinnedMsg?: Msg;
}

interface StoredDevice extends DeviceKeys {
  id: number;
}

// Invite and recovery links are routes: login and app screens show them.
export type Screen = 'loading' | 'login' | 'password' | 'pending' | 'lost' | 'app';

// ---------- state ----------

export const screen = signal<Screen>('loading');
export const me = signal<Me | null>(null);
export const chats = signal<Chat[]>([]);
export const messages = signal<Map<number, Msg[]>>(new Map());
export const hasOlder = signal<Map<number, boolean>>(new Map());
export const typing = signal<Map<number, Map<number, number>>>(new Map());
export const pending = signal<PendingDevice[]>([]);
export const connected = signal(false);
export const offline = signal(false); // no socket for a while: worth telling the user
let offlineTimer: ReturnType<typeof setTimeout> | undefined;
export const toast = signal<string | null>(null);
export const newPassword = signal<string | null>(null);
export const devicesTick = signal(0); // bumps when the device list changed
export const peerTick = signal(0); // a contact's devices may have changed: re-check safety codes

let device: StoredDevice | null = null;
const loaded = new Set<number>();
const keyCache = new Map<string, CryptoKey>();
const pubs = new Map<number, DevicePub>();
let seq = 0;

export const myId = () => me.value?.user.id ?? 0;
export const findChat = (id: number) => chats.value.find((c) => c.id === id);

let toastTimer: ReturnType<typeof setTimeout>;
export function showToast(text: string) {
  toast.value = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 4000);
}

// ---------- startup & auth ----------

// appReady settles once keys and the chat list are loaded: a call offer
// that arrives on a cold start (phone opened from the push) waits for it.
let markReady!: () => void;
export const appReady = new Promise<void>((r) => (markReady = r));

export async function start() {
  try {
    me.value = await api.me();
  } catch (e) {
    // Offline at startup: keep the splash and retry instead of a login form.
    if (e instanceof ApiError && e.code === 'network') {
      setTimeout(start, 3000);
      return;
    }
    me.value = null;
    screen.value = 'login';
    return;
  }
  device = (await idbGet<StoredDevice>('device')) ?? null;
  if (!device || device.id !== me.value.device.id) {
    screen.value = 'lost';
    return;
  }
  pubs.set(device.id, { id: device.id, user: me.value.user.id, enc_pub: toB64(device.encPub), sig_pub: toB64(device.sigPub) });
  connect();
  if (me.value.device.status === 'pending') {
    screen.value = 'pending';
    return;
  }
  seq = (await api.sync(Number.MAX_SAFE_INTEGER)).seq;
  await syncKeys(true);
  await loadChats();
  void loadVault().catch(() => {}); // my names from my other devices
  screen.value = 'app';
  markReady();
  loadPending();
  subscribe().catch(() => {});
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  const br = /YaBrowser/.test(ua)
    ? 'Yandex'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /SamsungBrowser/.test(ua)
          ? 'Samsung'
          : /Firefox|FxiOS/.test(ua)
            ? 'Firefox'
            : /Chrome|CriOS/.test(ua)
              ? 'Chrome'
              : /Safari/.test(ua)
                ? 'Safari'
                : '';
  return [os, br].filter(Boolean).join(' · ') || 'Browser';
}

const devicePayload = (k: DeviceKeys) => ({ enc_pub: toB64(k.encPub), sig_pub: toB64(k.sigPub), label: deviceLabel() });

async function persistDevice(id: number, k: DeviceKeys) {
  device = { id, ...k };
  await idbSet('device', device);
  // Ask the browser not to evict our keys under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
}

export async function login(password: string): Promise<void> {
  const stored = await idbGet<StoredDevice>('device');
  try {
    if (stored) {
      const { nonce } = await api.challenge();
      const sig = await sign(stored.sig.privateKey, concat(utf8('connect-login:'), fromB64(nonce)));
      await api.login({ password, device_id: stored.id, nonce, sig: toB64(sig) });
    } else {
      const k = await newDeviceKeys();
      const r = await api.login({ password, device: devicePayload(k) });
      await persistDevice(r.device_id, k);
    }
  } catch (e) {
    // This browser's device was disconnected: start over as a new device.
    if (e instanceof ApiError && e.code === 'device_revoked') {
      await forgetLocal();
      return login(password);
    }
    throw e;
  }
  await start();
}

// forgetLocal wipes this browser's store, and what is cached from it: a
// notification note still being written would put a chat back.
let localGen = 0;
async function forgetLocal() {
  clearDiagnostics();
  mediaUrls.clear();
  localGen++;
  names = null;
  vault = null;
  await namesLock(idbClear); // not under a sync writing my names
}

export async function resetDevice() {
  await forgetLocal();
  device = null;
}

export async function logout() {
  await unsubscribe().catch(() => {});
  await api.logout().catch(() => {});
  await forgetLocal();
  location.replace('/');
}

export async function myDeviceCode() {
  const d = device ?? (await idbGet<StoredDevice>('device'));
  return d ? deviceCode(d.encPub, d.sigPub) : null;
}

export async function askRecovery() {
  await api.recovery();
}

// ---------- keys ----------

const rawKey = (chat: number, epoch: number) => idbGet<Bytes>(`k:${chat}:${epoch}`);

let keySync: Promise<void> | null = null;
let lastKeySync = 0;

// syncKeys unwraps every chat key the server holds for this device that
// is not cached yet. Throttled: missing keys trigger it from many places.
export function syncKeys(force = false): Promise<void> {
  if (keySync) return keySync;
  if (!device || (!force && Date.now() - lastKeySync < 5000)) return Promise.resolve();
  const dev = device;
  keySync = (async () => {
    for (const k of await api.keys()) {
      const name = `k:${k.chat}:${k.epoch}`;
      if (await idbGet(name)) continue;
      try {
        await idbSet(name, await unwrapKey(fromB64(k.wrapped), dev.enc.privateKey, k.epoch));
      } catch {
        /* wrapped for an older key of ours: ignore */
      }
    }
    lastKeySync = Date.now();
  })().finally(() => (keySync = null));
  return keySync;
}

async function chatKey(chat: number, epoch: number): Promise<CryptoKey | null> {
  const id = `${chat}:${epoch}`;
  const cached = keyCache.get(id);
  if (cached) return cached;
  let raw = await rawKey(chat, epoch);
  if (!raw) {
    await syncKeys().catch(() => {});
    raw = await rawKey(chat, epoch);
  }
  if (!raw) return null;
  const k = await aesKey(raw);
  keyCache.set(id, k);
  return k;
}

async function loadPubs(ids: number[]) {
  const missing = [...new Set(ids)].filter((id) => !pubs.has(id));
  if (!missing.length) return;
  for (const p of await api.devicePubs(missing)) pubs.set(p.id, p);
}

async function wrapFor(devs: { id: number; enc_pub: string }[], chat: number, keys: Map<number, Bytes>) {
  const out: WrappedKey[] = [];
  for (const d of devs)
    for (const [epoch, raw] of keys)
      out.push({ chat, epoch, device: d.id, wrapped: toB64(await wrapKey(raw, fromB64(d.enc_pub), epoch)) });
  return out;
}

// heldKeys: the chat keys this device has, from epoch `from` on.
async function heldKeys(chat: Chat, from = 1): Promise<Map<number, Bytes>> {
  const keys = new Map<number, Bytes>();
  for (let e = Math.max(1, from); e <= chat.epoch; e++) {
    const raw = await rawKey(chat.id, e);
    if (raw) keys.set(e, raw);
  }
  return keys;
}

// ensureEpoch rotates the chat key when a member or device left, so the
// next message is unreadable for them. Returns the epoch to write with.
async function ensureEpoch(chatId: number): Promise<number> {
  let c = findChat(chatId);
  if (!c) throw new ApiError(404, 'not_found');
  if (!c.rotate) return c.epoch;
  const epoch = c.epoch + 1;
  const raw = rand(32);
  const keys = await wrapFor(await api.chatDevices(chatId), chatId, new Map([[epoch, raw]]));
  try {
    await api.rotate(chatId, epoch, keys);
    await idbSet(`k:${chatId}:${epoch}`, raw);
  } catch (e) {
    // Someone else rotated first, or the device set changed: reload and retry.
    if (!(e instanceof ApiError) || (e.code !== 'epoch' && e.code !== 'devices_changed')) throw e;
  }
  await loadChats();
  await syncKeys(true);
  c = findChat(chatId);
  if (!c || c.rotate) throw new ApiError(409, 'rotate');
  return c.epoch;
}

// ---------- decrypting ----------

const msgAad = (chat: number, epoch: number) => `m:${chat}:${epoch}`;

async function hydrateOne(r: RawMessage): Promise<Msg> {
  const m: Msg = { ...r };
  if (r.deleted || !r.body) return m;
  const key = await chatKey(r.chat, r.epoch);
  if (!key) {
    m.p = null;
    return m;
  }
  try {
    const body = fromB64(r.body);
    const aad = msgAad(r.chat, r.epoch);
    m.p = JSON.parse(fromUtf8(await open(key, aad, body)));
    const pub = pubs.get(r.device);
    m.bad =
      !pub?.sig_pub ||
      pub.user !== r.user ||
      !r.sig ||
      !(await verify(fromB64(pub.sig_pub), fromB64(r.sig), concat(utf8(aad), body)));
  } catch {
    m.p = null;
  }
  if (r.reactions?.length) {
    const groups = new Map<string, number[]>();
    for (const x of r.reactions) {
      const k = await chatKey(r.chat, x.epoch);
      if (!k) continue;
      try {
        const emoji = fromUtf8(await open(k, `r:${r.chat}:${r.id}:${x.epoch}`, fromB64(x.body)));
        groups.set(emoji, [...(groups.get(emoji) ?? []), x.user]);
      } catch {
        /* undecryptable reaction: skip */
      }
    }
    m.rx = [...groups];
  }
  return m;
}

async function hydrate(raw: RawMessage[]): Promise<Msg[]> {
  await loadPubs(raw.filter((m) => !m.deleted).map((m) => m.device)).catch(() => {});
  return Promise.all(raw.map(hydrateOne));
}

// ---------- my names for people ----------

// Names I give people. IndexedDB `names` is the readable copy here, the
// service worker's too; the personal vault carries them to my other devices
// (loadVault). A member carries the name to show; realName keeps the one
// from their profile.
let names: Record<number, string> | null = null;
const ownNames = async () => (names ??= (await idbGet<Record<number, string>>('names').catch(() => undefined)) ?? {});
// namesLock: `names` and `namesDirty` change together, in every tab of mine
// (they share IndexedDB); inside, read them from there, not from a cache.
const namesLock = <T>(fn: () => Promise<T>) => navigator.locks.request('names', fn);
const readNames = async () => (names = (await idbGet<Record<number, string>>('names')) ?? {});

function named(m: Member, own: Record<number, string>): Member {
  const real = m.realName ?? m.name;
  const mine = m.id !== myId() && own[m.id];
  return mine ? { ...m, name: mine, realName: real } : { ...m, name: real, realName: undefined };
}

// applyNames: the names to show from now on, here and in notifications.
async function applyNames(own: Record<number, string>) {
  await idbSet('names', own);
  names = own;
  chats.value = chats.value.map((c) => ({ ...c, members: c.members.map((m) => named(m, own)) }));
  void notePush(chats.value);
}

export async function setOwnName(user: number, name: string) {
  await namesLock(async () => {
    const own = { ...(await readNames()) };
    const v = name.trim().slice(0, 64);
    if (v) own[user] = v;
    else delete own[user];
    // Changed here, not yet in the vault: counted per person, so a sync that
    // started before this change does not take it as written.
    const dirty = (await idbGet<Record<number, number>>('namesDirty')) ?? {};
    dirty[user] = (dirty[user] ?? 0) + 1;
    await idbSet('namesDirty', dirty);
    await applyNames(own);
  });
  void loadVault().catch(() => {});
}

// ---------- the personal vault: my names on all my devices ----------

// The server keeps the names sealed with a key of mine (AAD
// `v:<me>:<epoch>:<version>`) and that key wrapped for each device of mine
// that I let have it (AAD `vk:<me>:<epoch>`, so it never passes for a chat
// key); see vault.go and ADR 0001. A device gets the key only by my hand:
// approving it, or "Share my names" after checking its code, never on the
// server's word. A device switched off makes the next writer start a new
// key; nobody left holding it (every device lost) starts the vault anew.
type Vault = { epoch: number; version: number; raw: Bytes | null; renew: boolean; keyFor: { id: number; enc_pub: string }[] };
let vault: Vault | null = null;
// vaultShare: my devices still without the key, while this one holds it.
export const vaultShare = signal<{ id: number; enc_pub: string; sig_pub: string }[]>([]);
// vaultWaiting: this device has no key yet, so its names stay here.
export const vaultWaiting = signal(false);
const vaultAad = (epoch: number, version: number) => `v:${myId()}:${epoch}:${version}`;
const vaultKeyAad = (epoch: number) => `vk:${myId()}:${epoch}`;
const sameNames = (a: Record<number, string>, b: Record<number, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[Number(k)] === v);
// newer: (epoch, version) after the newest this device has seen; older is a
// rollback the server may try, and is not believed.
const newer = (a: { e: number; v: number }, b: { e: number; v: number } | undefined) => !b || a.e > b.e || (a.e === b.e && a.v >= b.v);

// loadVault reads my names from the vault and puts this device's changes on
// top (namesDirty); the first time, the names kept here before the vault
// join it (namesSynced). Written meanwhile by another device: read again.
export const loadVault = latest(async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await syncVault();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
    }
  }
});

async function syncVault() {
  if (!device || !me.value) return;
  const dev = device;
  const gen = localGen;
  const v = await api.vault();
  const seen = await idbGet<{ e: number; v: number }>('vaultSeen');
  // A wrap that does not open: no key here.
  const raw = v.key ? await unwrapKey(fromB64(v.key), dev.enc.privateKey, v.epoch, vaultKeyAad(v.epoch)).catch(() => null) : null;
  let remote: Record<number, string> | null = null;
  if (raw && v.body && newer({ e: v.epoch, v: v.version }, seen))
    remote = await open(await aesKey(raw), vaultAad(v.epoch, v.version), fromB64(v.body))
      .then((b) => JSON.parse(fromUtf8(b)) as Record<number, string>)
      .catch(() => null);
  // With the key, a version older than one seen here (a restored backup, a
  // server rolling back) or a body that does not open is not believed: this
  // device writes its own names over it, under a new key.
  const refused = !!raw && !remote;
  if (gen !== localGen) return; // logged out meanwhile
  const lost = v.epoch > 0 && !!v.lost;
  vault = { epoch: v.epoch, version: v.version, raw, renew: !raw || refused || !!v.rotate, keyFor: v.key_for };
  vaultWaiting.value = v.epoch > 0 && !raw && !lost;
  vaultShare.value = raw ? v.missing.filter((d) => d.id !== dev.id) : [];
  if (vaultWaiting.value) return; // no key here yet: my other device shares it (Settings, Devices)
  const { base, dirty } = await namesLock(async () => {
    const local = await readNames();
    const dirty = (await idbGet<Record<number, number>>('namesDirty')) ?? {};
    const base: Record<number, string> = remote ? ((await idbGet<boolean>('namesSynced')) ? { ...remote } : { ...local, ...remote }) : { ...local };
    for (const id of Object.keys(dirty).map(Number)) {
      if (local[id]) base[id] = local[id];
      else delete base[id];
    }
    return { base, dirty };
  });
  let seenNow = remote && { e: v.epoch, v: v.version };
  // Nothing to keep yet (no vault, no names): no empty vault either.
  if (refused || (remote ? !sameNames(base, remote) || vault.renew : Object.keys(base).length > 0)) {
    seenNow = await writeVault(base, gen);
    if (!seenNow) return;
  }
  await namesLock(async () => {
    if (gen !== localGen) return;
    if (seenNow) await idbSet('vaultSeen', seenNow);
    // Only the changes this run wrote are done: one made meanwhile stays
    // marked, and shows on top until the next run writes it.
    const now = (await idbGet<Record<number, number>>('namesDirty')) ?? {};
    for (const [id, n] of Object.entries(dirty)) if (now[Number(id)] === n) delete now[Number(id)];
    const fresh = await readNames();
    for (const id of Object.keys(now).map(Number)) {
      if (fresh[id]) base[id] = fresh[id];
      else delete base[id];
    }
    await idbSet('namesDirty', now);
    await idbSet('namesSynced', true);
    await applyNames(base);
  });
}

// writeVault seals the names; under a new key, when there is none yet,
// none here (the vault lost), one was switched off or the vault was not
// believed, wrapped for the devices the server names for it: those that
// held the old key, or my ordinary devices for a first one (vault.go
// vaultKeySet). Returns what it wrote, null when logged out meanwhile.
async function writeVault(own: Record<number, string>, gen: number) {
  const st = vault!;
  let { epoch, raw } = st;
  let keys: VaultKey[] | undefined;
  if (!raw || st.renew) {
    const k = rand(32);
    const next = st.epoch + 1;
    keys = await Promise.all(st.keyFor.map(async (d) => ({ device: d.id, wrapped: toB64(await wrapKey(k, fromB64(d.enc_pub), next, vaultKeyAad(next))) })));
    raw = k;
    epoch = next;
  }
  const version = st.version + 1;
  const body = toB64(await seal(await aesKey(raw), vaultAad(epoch, version), utf8(JSON.stringify(own))));
  const r = await api.putVault({ version: st.version, epoch, body, keys });
  if (gen !== localGen) return null;
  vault = { ...st, epoch, version: r.version, raw, renew: false };
  return { e: epoch, v: r.version };
}

// shareMyNames hands the vault's key to a device of mine: approved here, or
// one whose code the person has just compared (Settings, Devices). A key
// replaced meanwhile (409 epoch): read the vault again and wrap the new one.
export async function shareMyNames(d: { id: number; enc_pub: string }) {
  const share = async () => {
    const st = vault;
    if (!st?.raw) return;
    await api.shareVault(st.epoch, [{ device: d.id, wrapped: toB64(await wrapKey(st.raw, fromB64(d.enc_pub), st.epoch, vaultKeyAad(st.epoch))) }]);
    vaultShare.value = vaultShare.value.filter((x) => x.id !== d.id);
  };
  if (!vault?.raw) await loadVault();
  await share().catch(async (e) => {
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    await loadVault();
    await share();
  });
}

async function decorate(raw: RawChat[]): Promise<Chat[]> {
  const own = await ownNames();
  const lasts = await hydrate(raw.flatMap((c) => (c.last ? [c.last] : [])));
  const pins = await hydrate(raw.flatMap((c) => (c.pinned_msg ? [c.pinned_msg] : [])));
  return Promise.all(
    raw.map(async (c) => {
      let titleText = '';
      if (c.title && c.title_epoch) {
        const k = await chatKey(c.id, c.title_epoch);
        if (k) titleText = await open(k, `t:${c.title_epoch}`, fromB64(c.title)).then(fromUtf8, () => '');
      }
      return {
        ...c,
        members: c.members.map((m) => named(m, own)),
        titleText,
        lastMsg: lasts.find((m) => m.chat === c.id),
        pinnedMsg: pins.find((m) => m.chat === c.id),
      };
    }),
  );
}

// ---------- chat list & messages ----------

let chatsReq: Promise<void> | null = null;
let chatsAgain = false;

// loadChats coalesces bursts of "chat changed" events into few requests.
export function loadChats(): Promise<void> {
  if (chatsReq) {
    chatsAgain = true;
    return chatsReq;
  }
  chatsReq = (async () => {
    do {
      chatsAgain = false;
      const before = new Map(chats.value.map((c) => [c.id, c.lastMsg]));
      const list = await decorate(await api.chats());
      batch(() => {
        for (const c of list) {
          const previous = findChat(c.id);
          const known = messages.value.get(c.id) ?? [];
          const started = before.get(c.id);
          const changed = previous?.lastMsg && (previous.lastMsg.id !== started?.id || previous.lastMsg.seq !== started?.seq)
            ? previous.lastMsg : undefined;
          c.cleared_upto = Math.max(c.cleared_upto, previous?.cleared_upto ?? 0);
          const read = c.members.find((m) => m.id === myId())?.last_read ?? 0;
          const previousRead = previous?.members.find((m) => m.id === myId())?.last_read ?? 0;
          if (previous && ((previousRead > read && (c.lastMsg?.id ?? 0) <= previousRead) || (changed && !changed.deleted && changed.id > (c.lastMsg?.id ?? 0)))) {
            c.unread = previous.unread;
          }
          c.members = c.members.map((m) => ({...m, last_read: Math.max(m.last_read, previous?.members.find((p) => p.id === m.id)?.last_read ?? 0)}));
          // Keep updates that arrived during this request, and newer
          // versions of the same message. A different, older cached last
          // message must not override an authoritative refresh after offline.
          const candidates = [...(c.lastMsg ? [c.lastMsg] : []), ...(changed ? [changed] : [])];
          const ids = new Set(candidates.map((m) => m.id));
          c.lastMsg = latestMessage([...candidates, ...known.filter((m) => ids.has(m.id))], c.cleared_upto);
          if (!c.lastMsg) c.unread = 0;
          if (c.pinnedMsg) {
            const pin = known.find((m) => m.id === c.pinnedMsg!.id);
            if (pin && pin.seq >= c.pinnedMsg.seq) c.pinnedMsg = pin.deleted ? undefined : pin;
          }
        }
        chats.value = list;
        const ids = new Set(list.map((c) => c.id));
        const map = new Map(messages.value);
        for (const [id, msgs] of map) {
          const c = list.find((x) => x.id === id);
          if (!ids.has(id)) {
            map.delete(id);
            loaded.delete(id);
          } else if (c && c.cleared_upto) map.set(id, msgs.filter((m) => m.id > c.cleared_upto));
        }
        messages.value = map;
      });
    } while (chatsAgain);
    void reconcileAvatar();
    void notePush(chats.value);
  })().finally(() => (chatsReq = null));
  return chatsReq;
}

function putMessages(chat: number, incoming: Msg[]) {
  if (!loaded.has(chat)) return;
  const map = new Map(messages.value);
  const cleared = findChat(chat)?.cleared_upto ?? 0;
  map.set(chat, merge(map.get(chat) ?? [], incoming).filter((m) => m.id > cleared));
  messages.value = map;
}

export async function openChat(id: number) {
  if (loaded.has(id)) return;
  loaded.add(id);
  try {
    const raw = await api.messages(id);
    const incoming = await hydrate(raw);
    putMessages(id, incoming);
    const cleared = findChat(id)?.cleared_upto ?? 0;
    hasOlder.value = new Map(hasOlder.value).set(id, raw.length === 50 && raw.every((m) => m.id > cleared));
  } catch (e) {
    loaded.delete(id);
    throw e;
  }
}

// One older-page request at a time; concurrent callers share it.
let olderReq: Promise<void> | null = null;
export function loadOlder(id: number): Promise<void> {
  if (olderReq) return olderReq;
  const list = messages.value.get(id);
  const oldest = list?.find((m) => !m.local)?.id;
  if (!oldest || !hasOlder.value.get(id)) return Promise.resolve();
  olderReq = (async () => {
    const raw = await api.messages(id, oldest);
    putMessages(id, await hydrate(raw));
    const cleared = findChat(id)?.cleared_upto ?? 0;
    hasOlder.value = new Map(hasOlder.value).set(id, raw.length === 50 && raw.every((m) => m.id > cleared));
  })().finally(() => (olderReq = null));
  return olderReq;
}

const isVisible = () => document.visibilityState === 'visible';
const openChatId = () => (route.value.name === 'chat' ? route.value.id : undefined);

// onMessage applies one new or changed message to the list and the chat.
function onMessage(m: Msg) {
  const last = findChat(m.chat)?.lastMsg;
  const previous = messages.value.get(m.chat)?.find((x) => x.id === m.id) ?? (last?.id === m.id ? last : undefined);
  if ((previous && previous.seq > m.seq) || m.id <= (findChat(m.chat)?.cleared_upto ?? 0)) return;
  putMessages(m.chat, [m]);
  const c = findChat(m.chat);
  if (!c) {
    loadChats();
    return;
  }
  const lastId = c.lastMsg?.id ?? 0;
  if (m.deleted && m.id === lastId) {
    chats.value = chats.value.map((x) => x.id === m.chat ? {...x, lastMsg: m} : x);
    loadChats();
    return;
  }
  if (m.deleted || m.id < lastId || (m.id === lastId && m.seq < (c.lastMsg?.seq ?? 0))) return;
  const fresh = m.id > lastId;
  const mine = m.user === myId();
  // Read only when looked at: a window behind others neither marks the
  // message read (no receipt for the sender) nor hides it from the count.
  const reading = openChatId() === m.chat && !away();
  chats.value = chats.value.map((x) =>
    x.id === m.chat ? { ...x, lastMsg: m, unread: fresh && !mine && !reading ? x.unread + 1 : x.unread } : x,
  );
  if (fresh && reading && !mine) markRead(m.chat);
  // Visible but not in front: the system shows it (a hidden page gets the
  // server's push, see notifyHere). Of a call only a missed one is worth a word, the way
  // the service worker says it.
  const cl = m.p?.cl;
  const missed = cl?.s === 'missed' || cl?.s === 'busy';
  // A hidden page with push leaves sound to the system. In-app message
  // sounds are rate-limited, and during calls require an explicit opt-in.
  const sound = fresh && !mine && (!cl || missed) && (document.visibilityState === 'visible' || !pushOn) && messageSoundAllowed(socketHold.call);
  if (sound) playSound('message');
  if (fresh && !mine && notifyHere() && (!cl || missed)) {
    const from = nameOf(m.chat, m.user);
    const text = cl ? `📞 ${t('call.missed')}` : summary(m.p);
    void notifyMessage(m.chat, m.id, from, text, t('notify.message'), t('notify.read'), !sound);
  }
}

let readTimer: ReturnType<typeof setTimeout> | undefined;
export function markRead(chatId: number) {
  const c = findChat(chatId);
  const myMember = c?.members.find((x) => x.id === myId());
  const last = c?.lastMsg?.id ?? 0;
  if (!c || !myMember || away() || (last <= myMember.last_read && c.unread === 0)) return;
  void clear('c' + chatId); // read here: its notifications are done
  chats.value = chats.value.map((x) =>
    x.id === chatId
      ? { ...x, unread: 0, members: x.members.map((mm) => (mm.id === myId() ? { ...mm, last_read: last } : mm)) }
      : x,
  );
  clearTimeout(readTimer);
  readTimer = setTimeout(() => api.read(chatId, last).catch(() => {}), 300);
}

async function retryLocked() {
  for (const [chat, list] of messages.value) {
    const locked = list.filter((m) => m.p === null && !m.local);
    if (locked.length) putMessages(chat, await hydrate(locked));
  }
}

// ---------- sending ----------

async function sealPayload(chatId: number, epoch: number, payload: Payload) {
  const key = await chatKey(chatId, epoch);
  if (!key || !device) throw new ApiError(409, 'rotate');
  const aad = msgAad(chatId, epoch);
  const body = await seal(key, aad, utf8(JSON.stringify(payload)));
  const sig = await sign(device.sig.privateKey, concat(utf8(aad), body));
  return { epoch, body: toB64(body), sig: toB64(sig) };
}

export const MAX_FILE = 50 * 1024 * 1024; // matches the server and nginx

// upload encrypts one attachment with its own key and stores the blob.
async function upload(chatId: number, item: Outgoing): Promise<Attachment> {
  let blob: Blob;
  let meta: Omit<Attachment, 'id' | 'k' | 's'>;
  switch (item.kind) {
    case 'image': {
      const img = await prepareImage(item.file, item.hd).catch(() => {
        throw new ApiError(400, 'image');
      });
      blob = img.blob;
      meta = { m: img.mime, w: img.w, h: img.h, th: img.th };
      break;
    }
    case 'clip': {
      blob = item.file;
      const v = await prepareVideo(item.file).catch(() => null);
      meta = v
        ? { t: 'clip', m: item.file.type || 'video/mp4', ...v }
        : { t: 'file', m: item.file.type || 'application/octet-stream', n: item.file.name.slice(0, 200) };
      break;
    }
    case 'file':
      blob = item.file;
      meta = { t: 'file', m: item.file.type || 'application/octet-stream', n: item.file.name.slice(0, 200) };
      if (isTrack(meta)) {
        const d = await audioDuration(item.file);
        if (d) meta.d = d;
      }
      break;
    case 'voice':
      blob = item.blob;
      meta = { t: 'voice', m: item.mime, d: item.d, wf: item.wf };
      break;
    case 'video':
      blob = item.blob;
      meta = { t: 'video', m: item.mime, d: item.d, w: item.w, h: item.h, th: item.th };
      break;
  }
  if (blob.size > MAX_FILE) throw new ApiError(413, 'too_large');
  const raw = rand(32);
  const sealed = await seal(await aesKey(raw), 'f', new Uint8Array(await blob.arrayBuffer()));
  const id = await api.upload(chatId, sealed);
  return { id, k: toB64u(raw), s: blob.size, ...meta };
}

function localPreview(item: Outgoing): LocalFile {
  switch (item.kind) {
    case 'image':
    case 'file':
    case 'clip':
      return { kind: item.kind, url: URL.createObjectURL(item.file), name: item.file.name };
    default:
      return { kind: item.kind, url: URL.createObjectURL(item.blob), d: item.d };
  }
}

// deliver seals and sends a payload, retrying once if the chat key moved on.
async function deliver(chatId: number, payload: Payload, media: string[], cid: string, replyTo?: number, quiet?: boolean) {
  for (let attempt = 0; ; attempt++) {
    try {
      const epoch = await ensureEpoch(chatId);
      const sealed = await sealPayload(chatId, epoch, payload);
      const saved = await api.send(chatId, { ...sealed, cid, reply_to: replyTo, media, quiet });
      onMessage((await hydrate([saved]))[0]);
      return;
    } catch (e) {
      if (attempt > 0 || !(e instanceof ApiError) || (e.code !== 'rotate' && e.code !== 'epoch')) throw e;
      await loadChats().catch(() => {});
      await syncKeys(true).catch(() => {});
    }
  }
}

let localSeq = 0;

export async function sendMessage(chatId: number, text: string, items: Outgoing[], replyTo?: Msg, lp?: LinkCard) {
  const cid = toB64u(rand(12));
  const rp = replyTo && {
    id: replyTo.id,
    n: replyTo.user === myId() ? (me.value?.user.name ?? '') : nameOf(chatId, replyTo.user),
    t: summary(replyTo.p).slice(0, 120),
  };
  const local: Msg = {
    id: 1e15 + ++localSeq,
    chat: chatId,
    user: myId(),
    device: device?.id ?? 0,
    cid,
    epoch: 0,
    seq: 0,
    at: Date.now(),
    reply_to: replyTo?.id,
    p: { t: text || undefined, rp, lp },
    files: items.map(localPreview),
    local: 'sending',
  };
  putMessages(chatId, [local]);
  let atts: Attachment[] | null = null;

  const attempt = async (): Promise<void> => {
    putMessages(chatId, [{ ...local, local: 'sending', retry: undefined }]);
    try {
      atts ??= await Promise.all(items.map((f) => upload(chatId, f)));
      const payload: Payload = { t: text || undefined, a: atts.length ? atts : undefined, rp, lp };
      await deliver(chatId, payload, atts.map((a) => a.id), cid, replyTo?.id);
      local.files?.forEach((f) => URL.revokeObjectURL(f.url));
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'image' || e.code === 'too_large')) showToast(errText(e));
      putMessages(chatId, [{ ...local, local: 'failed', retry: () => void attempt() }]);
    }
  };
  await attempt();
}

// forwardMessage re-encrypts a message for another chat. Attachments get
// a server-side copy there; their file keys ride inside the new payload.
export async function forwardMessage(m: Msg, to: number) {
  if (!m.p) throw new ApiError(400, 'bad_request');
  const a = await Promise.all((m.p.a ?? []).map(async (x) => ({ ...x, id: (await api.copyMedia(x.id, to)).id })));
  const n = m.p.fw?.n ?? (m.user === myId() ? (me.value?.user.name ?? '') : nameOf(m.chat, m.user));
  await deliver(to, { t: m.p.t, a: a.length ? a : undefined, fw: { n } }, a.map((x) => x.id), toB64u(rand(12)));
}

// Only a missed call needs a notification after the fact (busy: missed
// while on another call). Answered, declined or failed: the ring said it.
export async function sendCallLog(chatId: number, cl: CallLog) {
  await deliver(chatId, { cl }, [], toB64u(rand(12)), undefined, cl.s !== 'missed' && cl.s !== 'busy');
}

// Call signaling is sealed with the chat key so the server, which relays
// it, cannot change the DTLS fingerprints inside the SDP.
// Call signaling is sealed per kind (offer, answer, ice), so the server
// cannot replay one as another. Like a message it rotates a pending key
// first: a newcomer or a new device may not hold the current one.
export async function sealSignal(chatId: number, id: string, kind: string, text: string) {
  const epoch = await ensureEpoch(chatId);
  const key = await chatKey(chatId, epoch);
  if (!key) throw new ApiError(409, 'rotate');
  const body = await seal(key, `call:${chatId}:${id}:${kind}:${epoch}`, utf8(text));
  return { e: epoch, body: toB64(body) };
}

export async function openSignal(chatId: number, epoch: number, id: string, kind: string, body: string): Promise<string> {
  const key = await chatKey(chatId, epoch);
  if (!key) throw new ApiError(409, 'rotate');
  return fromUtf8(await open(key, `call:${chatId}:${id}:${kind}:${epoch}`, fromB64(body)));
}

export async function pinMessage(chatId: number, id: number) {
  await api.pin(chatId, id);
  await loadChats();
}

// ensureLoaded pages back until a message is in memory (a pin, a reply
// or a search hit far up the history). False when it no longer exists.
export async function ensureLoaded(chatId: number, id: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const list = messages.value.get(chatId) ?? [];
    if (list.some((m) => m.id === id && !m.deleted)) return true;
    if (!hasOlder.value.get(chatId) || (list[0] && list[0].id < id)) return false;
    await loadOlder(chatId);
  }
  return false;
}

// loadHistory pulls older pages for search; capped so a huge chat stays usable.
export async function loadHistory(chatId: number, pages = 40) {
  for (let i = 0; i < pages && hasOlder.value.get(chatId); i++) await loadOlder(chatId);
}

export async function editMessage(m: Msg, text: string) {
  const epoch = await ensureEpoch(m.chat);
  const sealed = await sealPayload(m.chat, epoch, { ...m.p, t: text || undefined });
  onMessage((await hydrate([await api.edit(m.id, sealed)]))[0]);
}

export async function deleteMessage(m: Msg) {
  if (m.local) {
    const map = new Map(messages.value);
    map.set(m.chat, (map.get(m.chat) ?? []).filter((x) => x.id !== m.id));
    messages.value = map;
    return;
  }
  onMessage((await hydrate([await api.deleteMessage(m.id)]))[0]);
}

export async function toggleReaction(m: Msg, emoji: string) {
  const mineNow = m.rx?.find(([, users]) => users.includes(myId()))?.[0];
  let saved: RawMessage;
  if (mineNow === emoji) {
    saved = await api.unreact(m.id);
  } else {
    const epoch = await ensureEpoch(m.chat);
    const key = await chatKey(m.chat, epoch);
    if (!key) throw new ApiError(409, 'rotate');
    const body = await seal(key, `r:${m.chat}:${m.id}:${epoch}`, utf8(emoji));
    saved = await api.react(m.id, { epoch, body: toB64(body) });
  }
  onMessage((await hydrate([saved]))[0]);
}

// wsSend pushes a client event over the socket; false when offline.
export function wsSend(obj: unknown): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

// The call module registers here (avoids an import cycle).
let callHandler: ((e: Record<string, unknown>) => void) | null = null;
export const setCallHandler = (fn: (e: Record<string, unknown>) => void) => (callHandler = fn);
// Group calls (group.ts): their events, and { t: 'open' } on each new socket.
let groupHandler: ((e: Record<string, unknown>) => void) | null = null;
export const setGroupHandler = (fn: (e: Record<string, unknown>) => void) => (groupHandler = fn);
// During a call the socket stays open even when the page is hidden.
export const socketHold = { call: false };

let typingSent = 0;
export function sendTyping(chatId: number) {
  if (Date.now() - typingSent < 3000 || ws?.readyState !== WebSocket.OPEN) return;
  typingSent = Date.now();
  ws.send(JSON.stringify({ t: 'typing', c: chatId }));
}

// ---------- media ----------

const mediaUrls = new MediaCache();
// The type comes from the sender: only media the app renders itself.
const PLAYABLE = /^(image\/(jpeg|png|webp|gif)|audio\/(mp4|webm|ogg|mpeg)|video\/(mp4|webm|quicktime))(;[\w=.,\s-]*)?$/;

// summary is the one-line text of a payload for previews, replies and pushes.
export function summary(p?: Payload | null): string {
  if (!p) return '';
  if (p.cl) return `📞 ${t('call.log')}`;
  if (p.t) return plain(p.t);
  const a = p.a?.[0];
  if (!a) return '';
  if (a.t === 'voice') return `🎤 ${t('att.voice')} ${fmtDuration(a.d ?? 0)}`;
  if (a.t === 'video') return `📹 ${t('att.video')}`;
  if (a.t === 'clip') return `🎬 ${t('att.clip')}`;
  if (isTrack(a)) return `🎵 ${[trackInfo(a).artist, trackInfo(a).title].filter(Boolean).join(' - ') || t('music.unknown')}`;
  if (a.t === 'file') return `📎 ${a.n ?? t('att.file')}`;
  return `📷 ${t('list.photo')}`;
}

export function acquireMedia(a: Attachment) {
  return mediaUrls.acquire(a.id, async () => {
    const key = await aesKey(fromB64(a.k));
    const data = await open(key, 'f', await api.download(a.id));
    const type = isTrack(a) ? trackMime(a) : PLAYABLE.test(a.m) && a.t !== 'file' ? a.m : 'application/octet-stream';
    return new Blob([data], { type });
  });
}

export async function mediaMessages(chatId: number, before = 0): Promise<Msg[]> {
  return hydrate(await api.messages(chatId, before, true));
}

// ---------- chats & invites ----------

// makeInvite seals the keys under a fresh link secret. A friend link (f/)
// is the same invite, opened sign-in only by the person's browser.
async function makeInvite(keys: Map<number, Bytes>, maxUses: number, friend = false) {
  const secret = rand(32);
  const { wrap, id } = await inviteKeys(secret);
  const k: Record<string, string> = {};
  for (const [e, raw] of keys) k[e] = toB64u(raw);
  const bundle = await seal(wrap, 'invite', utf8(JSON.stringify({ k })));
  return {
    invite: { id: toB64(id), bundle: toB64(bundle), max_uses: maxUses },
    link: `${location.origin}/#/${friend ? 'f' : 'i'}/${toB64u(secret)}`,
  };
}

async function myActiveDevices(exceptSelf: boolean) {
  const devs = (await api.devices()).filter((d) => d.status === 'active' && !(exceptSelf && d.current));
  await loadPubs(devs.map((d) => d.id));
  return devs.map((d) => pubs.get(d.id)!).filter(Boolean);
}

export async function createChat(kind: 'direct' | 'group', title: string, maxUses: number, friend = false) {
  const raw = rand(32);
  const keys = await wrapFor(await myActiveDevices(false), 0, new Map([[1, raw]]));
  const sealedTitle = title ? toB64(await seal(await aesKey(raw), 't:1', utf8(title))) : undefined;
  const { invite, link } = await makeInvite(new Map([[1, raw]]), maxUses, friend);
  const { chat_id } = await api.createChat({ kind, title: sealedTitle, keys, invite });
  await idbSet(`k:${chat_id}:1`, raw);
  await loadChats();
  return { chatId: chat_id, link };
}

export async function inviteToChat(chatId: number, maxUses: number): Promise<string> {
  const epoch = await ensureEpoch(chatId);
  const c = findChat(chatId);
  if (!c) throw new ApiError(404, 'not_found');
  let keys = await heldKeys(c);
  if (c.kind === 'direct') keys = new Map([...keys].filter(([e]) => e === epoch));
  if (!keys.has(epoch)) throw new ApiError(409, 'rotate');
  const { invite, link } = await makeInvite(keys, maxUses);
  await api.createInvite(chatId, invite);
  return link;
}

export interface Peeked {
  info: InviteInfo;
  auth: string;
  keys: Map<number, Bytes>;
  title: string;
}

export async function peekInvite(secret: string): Promise<Peeked> {
  const { auth, wrap } = await inviteKeys(fromB64(secret));
  const info = await api.peek(toB64(auth));
  const keys = new Map<number, Bytes>();
  if (info.bundle) {
    const { k } = JSON.parse(fromUtf8(await open(wrap, 'invite', fromB64(info.bundle))));
    for (const e in k) keys.set(Number(e), fromB64(k[e]));
  }
  let title = '';
  const te = info.title_epoch ?? 0;
  if (info.title && keys.has(te)) {
    title = fromUtf8(await open(await aesKey(keys.get(te)!), `t:${te}`, fromB64(info.title)));
  }
  return { info, auth: toB64(auth), keys, title };
}

async function storeBundle(chatId: number, keys: Map<number, Bytes>) {
  for (const [e, raw] of keys) await idbSet(`k:${chatId}:${e}`, raw);
}

// joinInvite: logged in -> join the chat; otherwise register with `name`.
export async function joinInvite(p: Peeked, name?: string): Promise<number> {
  if (me.value) {
    const r = await api.redeem({ key: p.auth });
    if (r.chat_id) {
      await storeBundle(r.chat_id, p.keys);
      // Hand the keys to my other devices, they were not part of the invite.
      const others = await myActiveDevices(true);
      if (others.length) await api.shareKeys(await wrapFor(others, r.chat_id, p.keys));
    }
    await loadChats();
    return r.chat_id;
  }
  const k = await newDeviceKeys();
  const r = await api.redeem({ key: p.auth, name, device: devicePayload(k) });
  await persistDevice(r.device_id!, k);
  if (r.chat_id) await storeBundle(r.chat_id, p.keys);
  newPassword.value = r.password ?? null;
  replace(r.chat_id ? `c/${r.chat_id}` : '');
  screen.value = 'password';
  return r.chat_id;
}

// ---------- recovery links ----------

// createRecoveryLink: someone I invited forgot their password. The link
// sets a new one and carries the keys of every chat we share; partners in
// other chats answer the new device's request for keys themselves.
export async function createRecoveryLink(userId: number): Promise<string> {
  const secret = rand(32);
  const { wrap, id } = await inviteKeys(secret, 'recovery');
  const c: Record<string, Record<string, string>> = {};
  for (const chat of chats.value) {
    if (!chat.members.some((m) => m.id === userId)) continue;
    const k: Record<string, string> = (c[chat.id] = {});
    for (const [e, raw] of await keysFor(chat, userId)) k[e] = toB64u(raw);
  }
  const bundle = await seal(wrap, 'recovery', utf8(JSON.stringify({ c })));
  await api.createRecovery({ user: userId, id: toB64(id), bundle: toB64(bundle) });
  return `${location.origin}/#/r/${toB64u(secret)}`;
}

export interface Recovery {
  auth: string;
  name: string;
  by: string;
  chats: Map<number, Map<number, Bytes>>;
}

export async function peekRecovery(secret: string): Promise<Recovery> {
  const { auth, wrap } = await inviteKeys(fromB64(secret), 'recovery');
  const r = await api.peekRecovery(toB64(auth));
  const { c } = JSON.parse(fromUtf8(await open(wrap, 'recovery', fromB64(r.bundle))));
  const chats = new Map<number, Map<number, Bytes>>();
  for (const id in c) chats.set(Number(id), new Map(Object.entries<string>(c[id]).map(([e, k]) => [Number(e), fromB64(k)])));
  return { auth: toB64(auth), name: r.name, by: r.by, chats };
}

export async function redeemRecovery(p: Recovery) {
  // Only reached signed in from the lost screen: the keys are gone already,
  // so the old session is worth nothing.
  if (me.value) {
    await api.logout().catch(() => {});
    me.value = null;
  }
  const k = await newDeviceKeys();
  // The server keeps copies for this device, so partners in these chats
  // are not asked for them; it accepts only chats shared with the inviter.
  const keys: Omit<WrappedKey, 'device'>[] = [];
  for (const [chat, ks] of p.chats)
    for (const [epoch, raw] of ks) keys.push({ chat, epoch, wrapped: toB64(await wrapKey(raw, k.encPub, epoch)) });
  const r = await api.redeemRecovery({ key: p.auth, device: devicePayload(k), keys });
  // Whatever this browser held stays until the link has worked.
  await resetDevice();
  await persistDevice(r.device_id, k);
  for (const chat of r.chats) {
    const ks = p.chats.get(chat);
    if (ks) await storeBundle(chat, ks);
  }
  newPassword.value = r.password;
  replace('');
  screen.value = 'password';
}

// openDirect opens my direct chat with a member of group `via`, making it
// first when there is none: its key is wrapped for every device of us both.
// A second tap while the first is still making it waits for that one.
const directs = new Map<number, Promise<void>>();
export function openDirect(userId: number, via: number): Promise<void> {
  let p = directs.get(userId);
  if (!p) {
    p = makeDirect(userId, via).finally(() => directs.delete(userId));
    directs.set(userId, p);
  }
  return p;
}

async function makeDirect(userId: number, via: number) {
  const have = chats.value.find((c) => c.kind === 'direct' && c.members.length === 2 && c.members.some((m) => m.id === userId));
  if (have) return goChat(have.id);
  for (let attempt = 0; ; attempt++) {
    const raw = rand(32);
    const theirs = (await api.chatDevices(via, true)).filter((d) => d.user === userId);
    const keys = await wrapFor([...(await myActiveDevices(false)), ...theirs], 0, new Map([[1, raw]]));
    try {
      const r = await api.directChat(userId, keys);
      if (!r.existing) await idbSet(`k:${r.chat_id}:1`, raw);
      await loadChats();
      return goChat(r.chat_id);
    } catch (e) {
      // A device appeared or left meanwhile: once more with the new set.
      if (attempt > 0 || !(e instanceof ApiError) || e.code !== 'devices_changed') throw e;
    }
  }
}

export async function leaveChat(chatId: number) {
  await api.leaveChat(chatId);
  replace('');
  await loadChats();
}

export async function clearHistory(chatId: number) {
  await api.clearHistory(chatId);
  await loadChats();
}

// ---------- devices ----------

export async function loadPending() {
  pending.value = await api.pending().catch(() => pending.value);
}

// keysFor: the keys of chat c that `user` may hold. A direct chat re-used
// for someone new keeps the earlier conversation from them.
async function keysFor(c: Chat, user: number) {
  const since = c.kind === 'direct' ? (c.members.find((m) => m.id === user)?.since ?? 0) : 0;
  return heldKeys(c, since);
}

// approveDevice hands a waiting device the keys: every chat for my own
// device, only shared chats for a partner's.
export async function approveDevice(p: PendingDevice) {
  const keys: WrappedKey[] = [];
  for (const c of chats.value) {
    if (!p.own && !c.members.some((m) => m.id === p.user)) continue;
    keys.push(...(await wrapFor([{ id: p.id, enc_pub: p.enc_pub }], c.id, p.own ? await heldKeys(c) : await keysFor(c, p.user))));
  }
  await api.approve(p.id, keys);
  await loadPending();
  devicesTick.value++;
  if (p.own) void shareMyNames(p).catch(() => {}); // its code was just checked: my names go to it
}

export async function denyDevice(p: PendingDevice) {
  await api.revoke(p.id);
  await loadPending();
  devicesTick.value++;
}

// ---------- safety codes ----------

export type Trust = 'none' | 'ok' | 'changed';

// safetyFor computes the code two people compare, and whether the other
// person's devices still match what was verified last time.
export async function safetyFor(chatId: number, userId: number): Promise<{ code: Code; fp: string; trust: Trust }> {
  const devs = await api.chatDevices(chatId, true);
  const mine = await fingerprint(devs.filter((d) => d.user === myId()));
  const theirs = await fingerprint(devs.filter((d) => d.user === userId));
  const fp = toHex(theirs);
  const saved = await idbGet<string>(`v:${userId}`);
  return { code: await safetyCode(mine, theirs), fp, trust: !saved ? 'none' : saved === fp ? 'ok' : 'changed' };
}

export async function trustOf(chatId: number, userId: number): Promise<Trust> {
  if (!(await idbGet(`v:${userId}`))) return 'none'; // never verified: nothing to compare
  return (await safetyFor(chatId, userId)).trust;
}

export const markVerified = (userId: number, fp: string | null) => idbSet(`v:${userId}`, fp ?? undefined);

// ---------- names ----------

export function nameOf(chatId: number, userId: number): string {
  return findChat(chatId)?.members.find((m) => m.id === userId)?.name ?? '';
}

export function partner(c: Chat) {
  return c.kind === 'direct' ? c.members.find((m) => m.id !== myId()) : undefined;
}

// ---------- realtime ----------

let ws: WebSocket | null = null;
let wsTimer: ReturnType<typeof setTimeout> | undefined;
let backoff = 1000;
const live = { startedAt: 0, lastIn: 0, pingAt: 0 };
const given = new WeakSet<WebSocket>(); // given up on: its late close changes nothing

// Phones keep the socket only while the app is visible: a hidden page is
// frozen, and Web Push takes over. Computers keep it in the background and
// say so ({t:'vis'}): the server still pushes to them for the system
// notification, and a call rings in the tab. A call keeps it everywhere:
// it carries the call's signaling.
const holdSocket = () => isVisible() || socketHold.call || !mobile;
const sendVis = () => wsSend({ t: 'vis', h: !isVisible() });

function connect() {
  if (ws || !me.value || !holdSocket()) return;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  ws = sock;
  Object.assign(live, { startedAt: Date.now(), lastIn: 0, pingAt: 0 });
  sock.onopen = () => {
    live.lastIn = Date.now();
    if (ws === sock) callHandler?.({ t: 'open' });
    backoff = 1000;
    connected.value = true;
    clearTimeout(offlineTimer);
    offline.value = false;
    if (!isVisible()) sendVis();
    if (screen.value === 'app') catchUp();
    void checkUpdate();
    groupHandler?.({ t: 'open' });
  };
  sock.onmessage = (e) => {
    if (ws === sock) live.lastIn = Date.now();
    try {
      handleEvent(JSON.parse(e.data));
    } catch {
      /* ignore malformed events */
    }
  };
  sock.onclose = () => !given.has(sock) && lost(sock);
}

function lost(sock: WebSocket) {
  if (ws === sock) { callHandler?.({ t: 'close' }); groupHandler?.({ t: 'close' }); }
  if (ws === sock) ws = null;
  connected.value = false;
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => (offline.value = !connected.value), 2000);
  clearTimeout(wsTimer);
  if (!holdSocket()) return; // visibilitychange reconnects
  // Mid-call every second counts: the call is reconnecting over it.
  wsTimer = setTimeout(connect, socketHold.call ? 1000 : backoff);
  backoff = Math.min(backoff * 2, 15000);
}

// watch asks a quiet socket whether it still carries events, and replaces one
// that does not answer (liveness.ts): the browser can take many minutes to
// close a dead connection by itself, and a ring sent there is lost. The new
// socket gets a ringing call from the server at once. probe: ask now, the
// network has just changed or the page came back.
function watch(probe = false) {
  const sock = ws;
  if (!sock) return;
  const now = Date.now();
  const open = sock.readyState === WebSocket.OPEN;
  const verdict = probe && open && live.pingAt <= live.lastIn ? 'ping' : check(now, { open, ...live });
  if (verdict === 'ping') {
    live.pingAt = now;
    sock.send(JSON.stringify({ t: 'ping' }));
  } else if (verdict === 'dead') {
    given.add(sock);
    lost(sock);
    sock.close();
  }
}
setInterval(watch, TICK_MS);
window.addEventListener('online', () => watch(true));

// Close at once when hidden on a phone: a frozen page runs no timers.
function dropSocket() {
  if (socketHold.call) return;
  const s = ws;
  ws = null;
  s?.close();
}

// releaseSocket: a call that held the socket while hidden has ended.
export function releaseSocket() {
  if (!holdSocket()) dropSocket();
}

document.addEventListener('visibilitychange', () => {
  if (isVisible()) {
    connect();
    watch(true);
    const id = openChatId();
    if (id) markRead(id);
  } else if (mobile) {
    dropSocket();
  }
  sendVis();
});
window.addEventListener('pagehide', dropSocket);
// Back in front: the open chat counts as read now (see onMessage).
window.addEventListener('focus', () => {
  const id = openChatId();
  if (id) markRead(id);
});

// Advance the sync cursor now and then, so a long session does not end up
// with more than one page of changes to catch up on.
setInterval(() => ws?.readyState === WebSocket.OPEN && catchUp(), 5 * 60e3);

let catching = false;
async function catchUp() {
  if (catching) return;
  catching = true;
  void loadVault().catch(() => {}); // events missed while the socket was down (a phone in the background)
  try {
    await syncKeys(true);
    const r = await api.sync(seq);
    if (r.full) {
      loaded.clear();
      messages.value = new Map();
      const id = openChatId();
      if (id) openChat(id);
    } else {
      const list = await hydrate(r.messages);
      const byChat = new Map<number, Msg[]>();
      for (const m of list) byChat.set(m.chat, [...(byChat.get(m.chat) ?? []), m]);
      for (const [c, ms] of byChat) putMessages(c, ms);
    }
    seq = r.seq;
    await loadChats();
    await loadPending();
    peerTick.value++; // events missed while away may include device changes
  } catch {
    /* next reconnect retries */
  } finally {
    catching = false;
  }
}

interface ServerEvent {
  t: string;
  m?: RawMessage;
  c?: number;
  u?: number;
  id?: number;
  online?: boolean;
  last_seen?: number;
}

async function handleEvent(e: ServerEvent) {
  switch (e.t) {
    case 'msg':
      if (e.m) onMessage((await hydrate([e.m]))[0]);
      break;
    case 'read':
      // Read on another of my devices: its notifications here are done.
      if (e.u === myId() && e.id! >= (findChat(e.c!)?.lastMsg?.id ?? 0)) void clear('c' + e.c);
      chats.value = chats.value.map((c) =>
        c.id === e.c
          ? {
              ...c,
              unread: e.u === myId() && e.id! >= (c.lastMsg?.id ?? 0) ? 0 : c.unread,
              members: c.members.map((m) => (m.id === e.u ? { ...m, last_read: Math.max(m.last_read, e.id!) } : m)),
            }
          : c,
      );
      break;
    case 'presence':
      chats.value = chats.value.map((c) =>
        c.members.some((m) => m.id === e.u)
          ? {
              ...c,
              members: c.members.map((m) =>
                m.id === e.u ? { ...m, online: !!e.online, last_seen: e.online ? m.last_seen : Date.now() } : m,
              ),
            }
          : c,
      );
      break;
    case 'typing': {
      const map = new Map(typing.value);
      const inChat = new Map(map.get(e.c!) ?? []);
      inChat.set(e.u!, Date.now() + 6000);
      map.set(e.c!, inChat);
      typing.value = map;
      setTimeout(() => (typing.value = new Map(typing.value)), 6100);
      break;
    }
    case 'chat':
      peerTick.value++;
      await syncKeys(true);
      await loadChats();
      retryLocked();
      if (openChatId() && !findChat(openChatId()!)) replace('');
      break;
    case 'user':
      loadChats();
      break;
    case 'keys':
      await syncKeys(true);
      retryLocked();
      break;
    case 'vault':
      void loadVault().catch(() => {});
      break;
    case 'device':
      loadPending();
      devicesTick.value++;
      void loadVault().catch(() => {}); // a new device of mine may now wait for my names
      break;
    case 'peer':
      peerTick.value++;
      break;
    case 'call':
      callHandler?.(e as unknown as Record<string, unknown>);
      break;
    case 'gcall':
      groupHandler?.(e as unknown as Record<string, unknown>);
      break;
    case 'approved': {
      // Reconnect: the socket was opened as a pending device.
      dropSocket();
      await start();
      break;
    }
  }
}

export function typingIn(chatId: number): number[] {
  const now = Date.now();
  return [...(typing.value.get(chatId) ?? [])].filter(([, until]) => until > now).map(([u]) => u);
}

// ---------- misc ----------

export function goChat(id: number) {
  if (route.value.name === 'chat' && route.value.id === id) return;
  if (route.value.name === 'chat' || route.value.name === 'info') replace(`c/${id}`);
  else go(`c/${id}`);
}

// A tapped notification opens its chat in place (see sw.js): navigating
// would reload the app. Answering tells the worker it need not navigate.
function openFrom(url: string) {
  const r = parse('#/' + (String(url).split('#/')[1] ?? ''));
  if (r.name === 'chat' && r.id) goChat(r.id);
  else if (route.value.name !== r.name) go(r.name === 'list' ? '' : r.name);
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.t !== 'open') return;
  e.ports[0]?.postMessage(1);
  openFrom(e.data.url);
});
nativeApp?.onOpen(openFrom); // a click on the app's own notification

// ---------- avatars, group photos, link previews ----------

// Decrypted pictures by "<chat>:<user>:<version>" (user 0 = group photo);
// null when there is none or it cannot be opened.
const pics = signal<Record<string, string | null>>({});
const picsLoading = new Set<string>();

const avatarAad = (chat: number, user: number, epoch: number) => (user ? `a:${chat}:${user}:${epoch}` : `p:${chat}:${epoch}`);

// ---------- what push notifications show ----------

// A push has no time for network round trips or for the chat's title and
// pictures, which only the app decrypts. So the app leaves each chat's
// name (a group's title, or the person, by the name I gave them) and a
// small icon (the group's photo or the person's avatar) in IndexedDB
// `push:<chat>` for the service worker and notify.ts. Same device, same
// trust as the chat keys kept there.
export interface PushNote {
  t: string; // the chat's name
  i?: string; // its picture as a data: URL
  g: boolean; // a group: "Name: text" under its title
  v: string; // what it was made from, to skip unchanged chats
}

async function notePush(list: Chat[]) {
  const gen = localGen;
  for (const c of list) {
    const p = partner(c);
    const pv = c.kind === 'group' ? c.photo_v : p?.avatar_v;
    const note: PushNote = { t: c.kind === 'group' ? c.titleText : (p?.name ?? ''), g: c.kind === 'group', v: '' };
    note.v = `${note.t}|${pv ?? 0}`;
    try {
      if ((await idbGet<PushNote>(`push:${c.id}`))?.v === note.v) continue;
      const b = pv ? await openPicture(c.id, c.kind === 'group' ? 0 : p!.id) : null;
      if (b) note.i = await dataUrl(b);
      else if (pv) note.v = ''; // no key for the picture yet: again next time
      if (gen !== localGen) return; // logged out or reset meanwhile: nothing goes back in
      await idbSet(`push:${c.id}`, note);
    } catch {
      /* the next chat list load tries again */
    }
  }
}

// dataUrl: a picture's bytes as a data: URL, typed by its first bytes.
function dataUrl(b: Bytes): Promise<string> {
  const type = b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : 'image/webp';
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(new Blob([b as BlobPart], { type }));
  });
}

async function openPicture(chat: number, user: number): Promise<Bytes | null> {
  const p = await (user ? api.avatar(chat, user) : api.photo(chat)).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
  if (!p) return null;
  const k = await chatKey(chat, p.epoch);
  return k ? open(k, avatarAad(chat, user, p.epoch), fromB64(p.body)) : null;
}

// picture returns the decrypted picture's URL, starting the fetch on first
// use; components re-render when it arrives.
export function picture(chat: number, user: number, v?: number): string | undefined {
  if (!v) return undefined;
  const key = `${chat}:${user}:${v}`;
  const got = pics.value[key];
  if (got !== undefined) return got ?? undefined;
  if (!picsLoading.has(key)) {
    picsLoading.add(key);
    openPicture(chat, user)
      .then(
        (b) => (b ? URL.createObjectURL(new Blob([b as BlobPart])) : null),
        () => null,
      )
      .then((url) => (pics.value = { ...pics.value, [key]: url }));
  }
  return undefined;
}

// chatPicture is what a chat shows: the group photo, or the partner's avatar.
export function chatPicture(c: Chat): string | undefined {
  if (c.kind === 'group') return picture(c.id, 0, c.photo_v);
  const p = partner(c);
  return p && picture(c.id, p.id, p.avatar_v);
}

const myMember = (c: Chat) => c.members.find((m) => m.id === myId());

// My avatar as others see it, from any chat that has the latest version.
export function myPicture(): string | undefined {
  const v = latestAvatar();
  const c = chats.value.find((x) => myMember(x)?.avatar_v === v);
  return c && picture(c.id, myId(), v);
}

function latestAvatar(): number {
  return Math.max(me.value?.user.avatar_v ?? 0, ...chats.value.map((c) => myMember(c)?.avatar_v ?? 0));
}

async function sealAvatar(list: Chat[], bytes: Bytes | null) {
  const items = [];
  for (const c of list) {
    const k = await chatKey(c.id, c.epoch);
    if (!k) continue; // this device has no key for it yet; the next sync fills it
    items.push({ chat: c.id, epoch: c.epoch, body: bytes ? toB64(await seal(k, avatarAad(c.id, myId(), c.epoch), bytes)) : null });
  }
  return items;
}

// setMyAvatar seals the picture once per chat. Without chats there is no
// one to show it to, and nowhere to keep it.
export async function setMyAvatar(file: Blob | null) {
  const bytes = file ? await prepareAvatar(file).catch(() => Promise.reject(new ApiError(400, 'image'))) : null;
  const items = await sealAvatar(chats.value, bytes);
  if (!items.length) throw new ApiError(400, 'no_chats');
  const { v } = await api.setAvatar({ items });
  me.value = { ...me.value!, user: { ...me.value!.user, avatar_v: v } };
  await loadChats();
}

// reconcileAvatar copies my latest avatar into chats that lag behind: a
// chat joined after it was set, or a direct chat re-keyed for a new person
// who cannot open the old key.
let reconciling = false;
async function reconcileAvatar() {
  const v = latestAvatar();
  if (!v || reconciling || me.value?.device.status !== 'active') return;
  const lag = chats.value.filter((c) => {
    const m = myMember(c);
    return m && (m.avatar_v !== v || (c.kind === 'direct' && (m.avatar_epoch ?? 0) < c.epoch));
  });
  const src = chats.value.find((c) => myMember(c)?.avatar_v === v);
  if (!lag.length || !src) return;
  reconciling = true;
  try {
    const items = await sealAvatar(lag, await openPicture(src.id, myId()));
    if (items.length) await api.setAvatar({ copy: true, v, items });
  } catch {
    /* tried again on the next chat list load */
  } finally {
    reconciling = false;
  }
}

export async function setGroupPhoto(c: Chat, file: Blob | null) {
  const k = await chatKey(c.id, c.epoch);
  if (!k) throw new ApiError(409, 'no_key');
  if (!file) return api.setPhoto(c.id, 0, null);
  const bytes = await prepareAvatar(file).catch(() => Promise.reject(new ApiError(400, 'image')));
  await api.setPhoto(c.id, c.epoch, toB64(await seal(k, avatarAad(c.id, 0, c.epoch), bytes)));
}

// linkCard asks the server for a page's preview (only with the setting on:
// the server learns the link) and shrinks its picture into the card. The
// card always links to what was typed, whatever the redirects said.
export async function linkCard(url: string): Promise<LinkCard> {
  const p = await api.preview(url);
  let i: string | undefined;
  if (p.image) i = await shrink(new Blob([fromB64(p.image) as BlobPart]), 320).catch(() => undefined);
  return { u: url, s: p.site, t: p.title, d: p.desc, i };
}

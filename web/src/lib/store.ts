import { batch, signal } from '@preact/signals';
import {
  api,
  ApiError,
  type DevicePub,
  type InviteInfo,
  type Me,
  type PendingDevice,
  type RawChat,
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
import { fmtDuration } from './recorder';
import { idbClear, idbGet, idbSet } from './idb';
import { prepareAvatar, prepareImage, prepareVideo, shrink } from './image';
import { plain } from './markup';
import { subscribe, unsubscribe } from './pwa';
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
}

// Outgoing is something to attach before it is encrypted and uploaded.
export type Outgoing =
  | { kind: 'image'; file: File }
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

export type Screen = 'loading' | 'login' | 'invite' | 'password' | 'pending' | 'lost' | 'app';

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
  const r = parse(location.hash);
  try {
    me.value = await api.me();
  } catch (e) {
    // Offline at startup: keep the splash and retry instead of a login form.
    if (e instanceof ApiError && e.code === 'network') {
      setTimeout(start, 3000);
      return;
    }
    me.value = null;
    screen.value = r.name === 'invite' ? 'invite' : 'login';
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
  screen.value = r.name === 'invite' ? 'invite' : 'app';
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
      await idbClear();
      return login(password);
    }
    throw e;
  }
  await start();
}

export async function resetDevice() {
  await idbClear();
  device = null;
}

export async function logout() {
  await unsubscribe().catch(() => {});
  await api.logout().catch(() => {});
  await idbClear();
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

async function decorate(raw: RawChat[]): Promise<Chat[]> {
  const lasts = await hydrate(raw.flatMap((c) => (c.last ? [c.last] : [])));
  const pins = await hydrate(raw.flatMap((c) => (c.pinned_msg ? [c.pinned_msg] : [])));
  return Promise.all(
    raw.map(async (c) => {
      let titleText = '';
      if (c.title && c.title_epoch) {
        const k = await chatKey(c.id, c.title_epoch);
        if (k) titleText = await open(k, `t:${c.title_epoch}`, fromB64(c.title)).then(fromUtf8, () => '');
      }
      return { ...c, titleText, lastMsg: lasts.find((m) => m.chat === c.id), pinnedMsg: pins.find((m) => m.chat === c.id) };
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
      const list = await decorate(await api.chats());
      batch(() => {
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
  })().finally(() => (chatsReq = null));
  return chatsReq;
}

function merge(list: Msg[], incoming: Msg[]): Msg[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) {
    for (const [id, x] of byId) if (x.local && x.cid === m.cid) byId.delete(id);
    byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function putMessages(chat: number, incoming: Msg[]) {
  if (!loaded.has(chat)) return;
  const map = new Map(messages.value);
  map.set(chat, merge(map.get(chat) ?? [], incoming));
  messages.value = map;
}

export async function openChat(id: number) {
  if (loaded.has(id)) return;
  loaded.add(id);
  try {
    const raw = await api.messages(id);
    hasOlder.value = new Map(hasOlder.value).set(id, raw.length === 50);
    const map = new Map(messages.value);
    map.set(id, merge(map.get(id) ?? [], await hydrate(raw)));
    messages.value = map;
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
    hasOlder.value = new Map(hasOlder.value).set(id, raw.length === 50);
    putMessages(id, await hydrate(raw));
  })().finally(() => (olderReq = null));
  return olderReq;
}

const isVisible = () => document.visibilityState === 'visible';
const openChatId = () => (route.value.name === 'chat' ? route.value.id : undefined);

// onMessage applies one new or changed message to the list and the chat.
function onMessage(m: Msg) {
  putMessages(m.chat, [m]);
  const c = findChat(m.chat);
  if (!c) {
    loadChats();
    return;
  }
  const lastId = c.lastMsg?.id ?? 0;
  if (m.deleted && m.id === lastId) {
    loadChats();
    return;
  }
  if (m.deleted || m.id < lastId) return;
  const fresh = m.id > lastId;
  const mine = m.user === myId();
  const reading = openChatId() === m.chat && isVisible();
  chats.value = chats.value.map((x) =>
    x.id === m.chat ? { ...x, lastMsg: m, unread: fresh && !mine && !reading ? x.unread + 1 : x.unread } : x,
  );
  if (fresh && reading && !mine) markRead(m.chat);
}

let readTimer: ReturnType<typeof setTimeout> | undefined;
export function markRead(chatId: number) {
  const c = findChat(chatId);
  const myMember = c?.members.find((x) => x.id === myId());
  const last = c?.lastMsg?.id ?? 0;
  if (!c || !myMember || !isVisible() || (last <= myMember.last_read && c.unread === 0)) return;
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
      const img = await prepareImage(item.file).catch(() => {
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
async function deliver(chatId: number, payload: Payload, media: string[], cid: string, replyTo?: number) {
  for (let attempt = 0; ; attempt++) {
    try {
      const epoch = await ensureEpoch(chatId);
      const sealed = await sealPayload(chatId, epoch, payload);
      const saved = await api.send(chatId, { ...sealed, cid, reply_to: replyTo, media });
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

export async function sendCallLog(chatId: number, cl: CallLog) {
  await deliver(chatId, { cl }, [], toB64u(rand(12)));
}

// Call signaling is sealed with the chat key so the server, which relays
// it, cannot change the DTLS fingerprints inside the SDP.
// Call signaling is sealed per kind (offer, answer, ice), so the server
// cannot replay one as another.
export async function sealSignal(chatId: number, id: string, kind: string, text: string) {
  const c = findChat(chatId);
  const key = c && (await chatKey(chatId, c.epoch));
  if (!c || !key) throw new ApiError(409, 'rotate');
  const body = await seal(key, `call:${chatId}:${id}:${kind}:${c.epoch}`, utf8(text));
  return { e: c.epoch, body: toB64(body) };
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
// During a call the socket stays open even when the page is hidden.
export const socketHold = { call: false };

let typingSent = 0;
export function sendTyping(chatId: number) {
  if (Date.now() - typingSent < 3000 || ws?.readyState !== WebSocket.OPEN) return;
  typingSent = Date.now();
  ws.send(JSON.stringify({ t: 'typing', c: chatId }));
}

// ---------- media ----------

const mediaUrls = new Map<string, Promise<string>>();
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
  if (a.t === 'file') return `📎 ${a.n ?? t('att.file')}`;
  return `📷 ${t('list.photo')}`;
}

export function mediaUrl(a: Attachment): Promise<string> {
  let p = mediaUrls.get(a.id);
  if (!p) {
    p = (async () => {
      const key = await aesKey(fromB64(a.k));
      const data = await open(key, 'f', await api.download(a.id));
      const type = PLAYABLE.test(a.m) && a.t !== 'file' ? a.m : 'application/octet-stream';
      return URL.createObjectURL(new Blob([data], { type }));
    })();
    p.catch(() => mediaUrls.delete(a.id));
    mediaUrls.set(a.id, p);
  }
  return p;
}

export async function mediaMessages(chatId: number, before = 0): Promise<Msg[]> {
  return hydrate(await api.messages(chatId, before, true));
}

// ---------- chats & invites ----------

async function makeInvite(keys: Map<number, Bytes>, maxUses: number) {
  const secret = rand(32);
  const { wrap, id } = await inviteKeys(secret);
  const k: Record<string, string> = {};
  for (const [e, raw] of keys) k[e] = toB64u(raw);
  const bundle = await seal(wrap, 'invite', utf8(JSON.stringify({ k })));
  return {
    invite: { id: toB64(id), bundle: toB64(bundle), max_uses: maxUses },
    link: `${location.origin}/#/i/${toB64u(secret)}`,
  };
}

async function myActiveDevices(exceptSelf: boolean) {
  const devs = (await api.devices()).filter((d) => d.status === 'active' && !(exceptSelf && d.current));
  await loadPubs(devs.map((d) => d.id));
  return devs.map((d) => pubs.get(d.id)!).filter(Boolean);
}

export async function createChat(kind: 'direct' | 'group', title: string, maxUses: number) {
  const raw = rand(32);
  const keys = await wrapFor(await myActiveDevices(false), 0, new Map([[1, raw]]));
  const sealedTitle = title ? toB64(await seal(await aesKey(raw), 't:1', utf8(title))) : undefined;
  const { invite, link } = await makeInvite(new Map([[1, raw]]), maxUses);
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

// The socket lives only while the app is visible; when hidden, Web Push
// takes over (the server pushes only to devices without a socket). A call
// keeps it, hidden or not: it carries the call's signaling.
function connect() {
  if (ws || !me.value || (!isVisible() && !socketHold.call)) return;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  ws = sock;
  sock.onopen = () => {
    backoff = 1000;
    connected.value = true;
    clearTimeout(offlineTimer);
    offline.value = false;
    if (screen.value === 'app') catchUp();
  };
  sock.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch {
      /* ignore malformed events */
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    connected.value = false;
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => (offline.value = !connected.value), 2000);
    clearTimeout(wsTimer);
    if (!isVisible() && !socketHold.call) return; // visibilitychange reconnects
    // Mid-call every second counts: the call is reconnecting over it.
    wsTimer = setTimeout(connect, socketHold.call ? 1000 : backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
}

// Close at once when hidden: a frozen page runs no timers, and while the
// server sees a live socket it sends no push for this device.
function dropSocket() {
  if (socketHold.call) return;
  const s = ws;
  ws = null;
  s?.close();
}

// releaseSocket: a call that held the socket while hidden has ended.
export function releaseSocket() {
  if (!isVisible()) dropSocket();
}

document.addEventListener('visibilitychange', () => {
  if (isVisible()) {
    connect();
    const id = openChatId();
    if (id) markRead(id);
  } else {
    dropSocket();
  }
});
window.addEventListener('pagehide', dropSocket);

// Advance the sync cursor now and then, so a long session does not end up
// with more than one page of changes to catch up on.
setInterval(() => ws?.readyState === WebSocket.OPEN && catchUp(), 5 * 60e3);

let catching = false;
async function catchUp() {
  if (catching) return;
  catching = true;
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
    case 'device':
      loadPending();
      devicesTick.value++;
      break;
    case 'peer':
      peerTick.value++;
      break;
    case 'call':
      callHandler?.(e as unknown as Record<string, unknown>);
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

// ---------- avatars, group photos, link previews ----------

// Decrypted pictures by "<chat>:<user>:<version>" (user 0 = group photo);
// null when there is none or it cannot be opened.
const pics = signal<Record<string, string | null>>({});
const picsLoading = new Set<string>();

const avatarAad = (chat: number, user: number, epoch: number) => (user ? `a:${chat}:${user}:${epoch}` : `p:${chat}:${epoch}`);

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

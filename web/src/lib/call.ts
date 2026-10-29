import { signal } from '@preact/signals';
import { api } from './api';
import { rand, toB64u } from './crypto';
import { refreshDevices, remember, remembered } from './devices';
import { mobile } from './pwa';
import { hangupTone, playSound } from './sounds';
import { type BgId, type EffectId, type Effects, type Look, startEffects } from './effects';
import { errText, t } from './i18n';
import { idbGet, idbSet } from './idb';
import { clear, notifyCall, notifyHere } from './notify';
import { type Level, preferCodecs, rate, tuneOpus, videoOrder } from './rtc';
import {
  appReady,
  type CallLog,
  findChat,
  openSignal,
  releaseSocket,
  sealSignal,
  sendCallLog,
  setCallHandler,
  showToast,
  socketHold,
  wsSend,
} from './store';

// 1:1 calls over WebRTC. Signaling rides the chat WebSocket, sealed with
// the chat key; media goes device to device (or through our TURN relay),
// encrypted by WebRTC itself (DTLS-SRTP).
//
// Stability: when media stops mid-call (network change, a tunnel), the
// caller restarts ICE and keeps re-offering until it connects again or 30 s
// pass; the callee asks it to. Quality: Opus with FEC and RED redundancy at
// up to 48 kbit/s, 720p30 video capped at 2.5 Mbit/s, audio ahead of video
// when bandwidth runs short, codecs the phone encodes in hardware.

export type Phase = 'outgoing' | 'incoming' | 'connecting' | 'active';

export interface Quality {
  level: Level;
  relay: boolean; // through our TURN server rather than direct
  rtt?: number; // ms
  kbps?: number; // incoming, all media
  res?: string; // incoming video, e.g. 1280×720
}

export interface CallView {
  id: string;
  chat: number;
  peer: number;
  video: boolean; // the call shows video (started as a video call, or a camera came on)
  canVideo?: boolean; // the connection has a video slot: the camera can come on mid-call
  phase: Phase;
  muted: boolean;
  camOff: boolean;
  since?: number;
  reconnecting?: boolean;
  q?: Quality;
  peerCamOff?: boolean; // told over the call's own data channel
  peerMuted?: boolean;
  peerBattery?: { level: number; charging: boolean }; // level in %, where their browser knows it
  effect?: EffectId; // drawn over our camera (effects.ts)
  bg?: BgId; // behind us: blurred or replaced
  screen?: boolean; // we show our screen instead of the camera
  peerScreen?: boolean; // they show theirs: it is always shown whole
  effectLoading?: boolean;
  local?: MediaStream;
  remote?: MediaStream;
}

export const call = signal<CallView | null>(null);

const RING_MS = 45_000;
const LOST_MS = 30_000; // no media for this long ends the call
const VIDEO_BITRATE = 2_500_000; // 720p30, plenty for a face

let pc: RTCPeerConnection | null = null;
let peerDevice = 0;
let outIce: RTCIceCandidateInit[] = []; // ours, until we know the peer device
let inIce: RTCIceCandidateInit[] = []; // theirs, until the remote description is set
let offer: { body: string; e: number; dev: number } | null = null;
let caller = false;
let outcome: CallLog['s'] = 'missed';
let ringTimer: ReturnType<typeof setTimeout> | undefined;
let lostTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let stopTone: (() => void) | null = null;
let wake: WakeLockSentinel | null = null;
let state: RTCDataChannel | null = null; // camera and microphone state, device to device
const ended = new Set<string>(); // calls that ended before they rang here
const device = videoOrder(navigator.userAgent);

const update = (patch: Partial<CallView>) => {
  if (call.value) call.value = { ...call.value, ...patch };
};

// The ring, the line while calling and the end tone: sounds.ts plays
// what this device chose (Settings, Sounds).
const ringtone = () => playSound('ring');
const ringback = () => playSound('dial');

function quiet() {
  stopTone?.();
  stopTone = null;
  clearTimeout(ringTimer);
  void clear('call'); // answered, declined, taken elsewhere or over
}
quiet(); // a ring left on screen from before the app opened


// The buttons on the call notification (notify.ts, sw.js).
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.t !== 'call' || call.value?.phase !== 'incoming') return;
  if (e.data.k === 'answer') void accept(call.value.video);
  else if (e.data.k === 'decline') decline();
});

// The camera: the one picked in the devices menu (remembered), else the
// front or back one. "ideal", not "exact": a camera unplugged since then
// falls back to another instead of failing the call.
let camId = remembered('callCam');
let facing: 'user' | 'environment' = 'user';
const CAMERA = (): MediaTrackConstraints => ({
  ...(camId ? { deviceId: { ideal: camId } } : { facingMode: facing }),
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
});

const MIC: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 };

// The speaker chosen in the call's sound menu; '' is the system default.
export const speaker = signal(remembered('callSpeaker'));

async function media(video: boolean): Promise<MediaStream> {
  const mic = remembered('callMic');
  const s = await navigator.mediaDevices.getUserMedia({
    audio: mic ? { ...MIC, deviceId: { ideal: mic } } : MIC,
    video: video ? CAMERA() : false,
  });
  hint(s);
  void refreshDevices(); // labels and the full list appear after the permission
  return s;
}

// iOS 17+: declaring a call before the microphone opens is the only way a
// page can steer the route. A voice call asks for the phone-call session
// (earpiece, like a phone call); video calls keep the default (loudspeaker).
type WithAudioSession = Navigator & { audioSession?: { type: string } };
function audioSession(type: 'play-and-record' | 'auto') {
  const s = (navigator as WithAudioSession).audioSession;
  if (s) s.type = type;
}

const senderOf = (kind: 'audio' | 'video') => pc?.getTransceivers().find((tr) => tr.receiver.track.kind === kind)?.sender;

// sendState tells the other side whether our camera and microphone are on,
// so it shows our avatar instead of a black picture, and how charged our
// battery is.
function sendState() {
  const v = call.value;
  // A desktop without a battery reads as full and charging: say nothing then
  // (a full laptop on the charger loses nothing by it either).
  const b =
    battery && !(battery.level === 1 && battery.charging)
      ? { level: Math.round(battery.level * 100), charging: battery.charging }
      : undefined;
  if (v && state?.readyState === 'open') state.send(JSON.stringify({ camOff: v.camOff, muted: v.muted, screen: !!v.screen, battery: b }));
}

// The Battery API exists in Chromium browsers only (not Safari or Firefox):
// elsewhere the other side just sees no battery line. Changes resend the
// state while a call runs.
type Battery = EventTarget & { level: number; charging: boolean };
let battery: Battery | null = null;

async function watchBattery() {
  const nav = navigator as Navigator & { getBattery?: () => Promise<Battery> };
  if (battery || !nav.getBattery) return;
  const b = await nav.getBattery().catch(() => null);
  if (!b || battery || !call.value) return; // the call may be over by now
  battery = b;
  battery.addEventListener('levelchange', sendState);
  battery.addEventListener('chargingchange', sendState);
  sendState();
}

function unwatchBattery() {
  battery?.removeEventListener('levelchange', sendState);
  battery?.removeEventListener('chargingchange', sendState);
  battery = null;
}

function peerBattery(b: unknown): CallView['peerBattery'] {
  const { level, charging } = (b ?? {}) as { level?: unknown; charging?: unknown };
  return typeof level === 'number' && level >= 0 && level <= 100 && typeof charging === 'boolean'
    ? { level: Math.round(level), charging }
    : undefined;
}

// Hints tell the encoder what matters: smooth motion for a face (drop
// resolution before frame rate), speech for the microphone.
function hint(s: MediaStream) {
  s.getVideoTracks().forEach((tr) => (tr.contentHint = 'motion'));
  s.getAudioTracks().forEach((tr) => (tr.contentHint = 'speech'));
}

// keepAwake holds the screen on during a video call; the OS drops the lock
// when the app is hidden, so it is taken again on return.
async function keepAwake() {
  if (!call.value?.video || wake || document.visibilityState !== 'visible') return;
  wake = (await navigator.wakeLock?.request('screen').catch(() => null)) ?? null;
  wake?.addEventListener('release', () => (wake = null));
}
document.addEventListener('visibilitychange', () => void keepAwake());

async function sendIce(c: RTCIceCandidateInit) {
  const v = call.value;
  if (!v) return;
  const { e, body } = await sealSignal(v.chat, v.id, 'ice', JSON.stringify(c));
  wsSend({ t: 'call', k: 'ice', c: v.chat, id: v.id, to: peerDevice, e, body });
}

// codecs: RED (redundant Opus) first for audio; video in the order this
// device encodes best. A desktop answerer follows the caller (see videoOrder).
function codecs(p: RTCPeerConnection, offering: boolean) {
  for (const tr of p.getTransceivers()) {
    const kind = tr.receiver.track.kind;
    const caps = RTCRtpReceiver.getCapabilities(kind)?.codecs;
    if (!caps || !tr.setCodecPreferences) continue;
    try {
      if (kind === 'audio') tr.setCodecPreferences(preferCodecs(caps, ['audio/red', 'audio/opus']));
      else if (offering || device.mobile) tr.setCodecPreferences(preferCodecs(caps, device.order));
    } catch {
      /* the browser's own order still works */
    }
  }
}

// senders: video capped for 720p30; audio marked high priority, so under
// congestion the picture degrades first and the voice stays clear.
async function senders(p: RTCPeerConnection) {
  for (const s of p.getSenders()) {
    if (!s.track) continue;
    const params = s.getParameters();
    const enc = params.encodings?.[0];
    if (!enc) continue;
    if (s.track.kind === 'audio') {
      enc.priority = 'high';
      enc.networkPriority = 'high';
    } else {
      enc.maxBitrate = VIDEO_BITRATE;
      enc.maxFramerate = 30;
    }
    await s.setParameters(params).catch(() => {});
  }
}

async function localDescription(p: RTCPeerConnection, d: RTCSessionDescriptionInit) {
  await p.setLocalDescription({ type: d.type, sdp: tuneOpus(d.sdp ?? '') });
}

async function connect(local: MediaStream): Promise<RTCPeerConnection> {
  const iceServers = await api.turn().then((r) => r.ice_servers, () => []);
  // One transport for audio and video: one relay allocation, not two. No
  // iceCandidatePoolSize: with pre-gathered candidates the next call after
  // a hang-up hung in "connecting" (the callee could not resolve the
  // caller's reused mDNS host name), seen in Chrome 152.
  const p = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  local.getTracks().forEach((tr) => p.addTrack(tr, local));
  // Negotiated on both sides with the same id: no signaling, and it rides
  // the call's DTLS transport, so it is end-to-end encrypted like the media.
  state = p.createDataChannel('state', { negotiated: true, id: 0 });
  state.onopen = sendState;
  void watchBattery();
  state.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      update({ peerCamOff: m.camOff === true, peerMuted: m.muted === true, peerScreen: m.screen === true, peerBattery: peerBattery(m.battery) });
    } catch {
      /* not ours to read */
    }
  };
  p.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    const c = ev.candidate.toJSON();
    if (peerDevice) sendIce(c).catch(() => {});
    else outIce.push(c);
  };
  // One remote stream for the whole call: a voice call's video slot comes
  // without a stream and must not replace the one that carries the sound.
  p.ontrack = (ev) => {
    const tracks = call.value?.remote?.getTracks() ?? [];
    if (!tracks.includes(ev.track)) update({ remote: new MediaStream([...tracks, ev.track]) });
  };
  p.onconnectionstatechange = () => {
    const v = call.value;
    if (!v || pc !== p) return;
    const st = p.connectionState;
    if (st === 'connected') {
      clearTimeout(lostTimer);
      clearTimeout(retryTimer);
      lostTimer = retryTimer = undefined;
      if (v.phase !== 'active') {
        quiet();
        outcome = 'ok';
        update({ phase: 'active', since: Date.now() });
        senders(p);
        statsTimer ??= setInterval(sample, 2000);
      } else if (v.reconnecting) update({ reconnecting: false });
    } else if (st === 'disconnected' || st === 'failed') {
      if (v.phase === 'active') lost(st === 'failed');
      else if (st === 'failed') hangup('failed');
    }
  };
  pc = p;
  return p;
}

// lost: media stopped mid-call. Re-negotiate now and every 5 s (the socket
// may be reconnecting too) until it connects again; give up after LOST_MS.
function lost(now: boolean) {
  update({ reconnecting: true });
  lostTimer ??= setTimeout(() => hangup('failed'), LOST_MS);
  if (retryTimer) return;
  const again = () => {
    void renegotiate();
    retryTimer = setTimeout(again, 5000);
  };
  retryTimer = setTimeout(again, now ? 0 : 2000); // "disconnected" often heals on its own
}

// renegotiate restarts ICE: only the caller offers (no glare); the callee
// asks it to. Media keeps flowing on the old path until the new one works.
async function renegotiate() {
  const v = call.value;
  if (!v || !pc || v.phase !== 'active') return;
  if (!caller) {
    wsSend({ t: 'call', k: 'restart', c: v.chat, id: v.id, to: peerDevice });
    return;
  }
  try {
    if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
    await localDescription(pc, await pc.createOffer({ iceRestart: true }));
    const { e, body } = await sealSignal(v.chat, v.id, 'reoffer', JSON.stringify(pc.localDescription));
    wsSend({ t: 'call', k: 'reoffer', c: v.chat, id: v.id, to: peerDevice, e, body });
  } catch {
    /* the next retry tries again */
  }
}

// A new network (Wi-Fi to mobile data) gets a fresh path at once instead
// of waiting for the old one to time out.
const onNetwork = () => void renegotiate();
addEventListener('online', onNetwork);
// navigator.connection (Network Information API) is missing from lib.dom.
(navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener('change', onNetwork);

// RTCStats entries are dictionaries whose fields depend on "type".
type Stat = { type: string; [k: string]: unknown };
let prev: { at: number; bytes: number; lost: number; got: number } | null = null;

async function sample() {
  const p = pc;
  if (!p) return;
  const report = await p.getStats().catch(() => null);
  if (!report) return;
  const get = (id: unknown) => report.get(id as string) as Stat | undefined;
  let pair: Stat | undefined;
  report.forEach((s: Stat) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = get(s.selectedCandidatePairId);
  });
  report.forEach((s: Stat) => {
    if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
  });
  let bytes = 0;
  let lost = 0;
  let got = 0;
  let res: string | undefined;
  report.forEach((s: Stat) => {
    if (s.type !== 'inbound-rtp') return;
    bytes += Number(s.bytesReceived ?? 0);
    lost += Math.max(0, Number(s.packetsLost ?? 0));
    got += Number(s.packetsReceived ?? 0);
    if (s.kind === 'video' && s.frameWidth) res = `${s.frameWidth}×${s.frameHeight}`;
  });
  const rtt = typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : undefined;
  const relay = [pair?.localCandidateId, pair?.remoteCandidateId].some((id) => get(id)?.candidateType === 'relay');
  const now = Date.now();
  const q: Quality = { level: 'good', relay, rtt, res };
  if (prev) {
    const dl = lost - prev.lost;
    const dg = got - prev.got;
    q.kbps = Math.round(((bytes - prev.bytes) * 8) / (now - prev.at));
    q.level = rate(rtt, dl + dg > 0 ? (100 * dl) / (dl + dg) : 0);
  }
  prev = { at: now, bytes, lost, got };
  if (pc === p) update({ q });
}

async function flushIce() {
  for (const c of outIce.splice(0)) await sendIce(c).catch(() => {});
  if (pc?.remoteDescription) for (const c of inIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
}

function fail(e: unknown) {
  const name = (e as DOMException)?.name;
  showToast(name === 'NotAllowedError' || name === 'NotFoundError' ? t('call.noMedia') : errText(e));
  hangup('failed');
}

export async function startCall(chatId: number, peer: number, video: boolean) {
  if (call.value) return;
  const id = toB64u(rand(9));
  caller = true;
  outcome = 'missed';
  socketHold.call = true;
  call.value = { id, chat: chatId, peer, video, phase: 'outgoing', muted: false, camOff: !video };
  void keepAwake();
  if (!video) audioSession('play-and-record');
  try {
    const local = await media(video);
    update({ local });
    const p = await connect(local);
    // A voice call opens a video slot too (no media flows until a camera is
    // on), so either side can turn its camera on later without renegotiating.
    if (!video) p.addTransceiver('video', { direction: 'sendrecv' });
    update({ canVideo: true });
    codecs(p, true);
    await localDescription(p, await p.createOffer());
    const { e, body } = await sealSignal(chatId, id, 'offer', JSON.stringify(p.localDescription));
    if (!wsSend({ t: 'call', k: 'offer', c: chatId, id, v: video, e, body })) throw new Error('network');
    stopTone = ringback();
    ringTimer = setTimeout(() => hangup('missed'), RING_MS);
  } catch (e) {
    fail(e);
  }
}

export async function accept(withVideo: boolean) {
  const v = call.value;
  if (!v || v.phase !== 'incoming' || !offer) return;
  quiet();
  const video = v.video && withVideo;
  peerDevice = offer.dev;
  update({ phase: 'connecting', camOff: !video });
  void keepAwake();
  if (!video) audioSession('play-and-record');
  try {
    const local = await media(video);
    update({ local });
    const p = await connect(local);
    await p.setRemoteDescription(JSON.parse(await openSignal(v.chat, offer.e, v.id, 'offer', offer.body)));
    // Keep the video slot able to send even without a camera now (a voice
    // call, or answered without video), so the camera can come on later.
    const slot = p.getTransceivers().find((tr) => tr.receiver.track.kind === 'video');
    if (slot) slot.direction = 'sendrecv';
    update({ canVideo: !!slot });
    codecs(p, false);
    await localDescription(p, await p.createAnswer());
    const { e, body } = await sealSignal(v.chat, v.id, 'answer', JSON.stringify(p.localDescription));
    wsSend({ t: 'call', k: 'answer', c: v.chat, id: v.id, to: peerDevice, e, body });
    await flushIce();
  } catch (e) {
    fail(e);
  }
}

export function decline() {
  const v = call.value;
  if (!v || !offer) return;
  wsSend({ t: 'call', k: 'decline', c: v.chat, id: v.id, to: offer.dev });
  cleanup();
}

export function hangup(reason?: CallLog['s']) {
  const v = call.value;
  if (!v) return;
  if (reason) outcome = reason;
  // Before an answer the callee may ring on several devices: tell them all.
  wsSend({ t: 'call', k: 'hangup', c: v.chat, id: v.id, to: peerDevice || 0 });
  finish();
}

// finish ends the call here; the caller writes the call into the chat.
function finish() {
  const v = call.value;
  if (v && caller) {
    const d = v.phase === 'active' && v.since ? Date.now() - v.since : 0;
    sendCallLog(v.chat, { v: v.video, d, s: d ? 'ok' : outcome }).catch(() => {});
  }
  cleanup();
}

function cleanup() {
  // Only a call that rang or ran here ends with a sound: not a declined,
  // missed or elsewhere-answered one.
  const rang = !!call.value && call.value.phase !== 'incoming';
  quiet();
  clearTimeout(lostTimer);
  clearTimeout(retryTimer);
  clearInterval(statsTimer);
  lostTimer = retryTimer = statsTimer = undefined;
  prev = null;
  wake?.release().catch(() => {});
  wake = null;
  state = null;
  unwatchBattery();
  audioSession('auto');
  dropEffects();
  call.value?.local?.getTracks().forEach((tr) => tr.stop());
  pc?.close();
  pc = null;
  peerDevice = 0;
  outIce = [];
  inIce = [];
  offer = null;
  camBefore = false;
  socketHold.call = false;
  releaseSocket();
  call.value = null;
  if (rang) hangupTone(); // after the call's audio is gone: speaker, not earpiece
}

export function toggleMute() {
  const v = call.value;
  if (!v) return;
  v.local?.getAudioTracks().forEach((tr) => (tr.enabled = v.muted));
  update({ muted: !v.muted });
  sendState();
}

// useCamera puts a fresh camera track (the chosen one) into the call and
// the self view; the previous one is stopped.
async function useCamera(): Promise<void> {
  const v = call.value;
  const sender = senderOf('video');
  if (!v || !sender) return;
  const s = await navigator.mediaDevices.getUserMedia({ video: CAMERA() });
  hint(s);
  const track = s.getVideoTracks()[0];
  // The call ended, or a screen went in, while the camera was opening.
  if (call.value?.id !== v.id || call.value.screen) return track.stop();
  const keep = fx?.look; // the effect and background move over to the new camera
  try {
    await sender.replaceTrack(track);
  } catch (e) {
    track.stop();
    throw e;
  }
  dropEffects(); // the old camera and its effect, now that they are not sent
  const now = call.value?.local;
  now?.getVideoTracks().forEach((tr) => tr.stop());
  update({ local: new MediaStream([...(now?.getAudioTracks() ?? []), track]), effect: undefined, bg: undefined });
  if (keep) void setLook(keep);
}

// Effects (effects.ts) put a canvas track in place of the camera, in the
// call and in the self view; fx keeps the camera underneath.
let fx: Effects | null = null;

// A hidden page stops drawing (no frame callbacks), which would freeze the
// picture the other side sees: send the bare camera until it is back.
document.addEventListener('visibilitychange', () => {
  if (fx) senderOf('video')?.replaceTrack(document.hidden ? fx.camera : fx.track).catch(() => {}); // a closing call
});

// dropEffects stops the effect canvas and the camera under it.
function dropEffects() {
  fx?.stop();
  fx?.camera.stop();
  fx = null;
}

// setLook changes what the camera wears: an effect, a background, both
// or neither (null). The engine and its models download on first use.
async function setLook(patch: Partial<Look>) {
  const v = call.value;
  const sender = senderOf('video');
  if (!v || !sender || v.camOff || v.screen) return;
  const next: Look = { effect: v.effect ?? null, bg: v.bg ?? null, ...patch };
  const shown = (l: Look) => ({ effect: l.effect ?? undefined, bg: l.bg ?? undefined });
  if (fx && !next.effect && !next.bg) {
    // Nothing left to draw: the bare camera goes back into the call state
    // first, so a call that ends meanwhile stops it and its light goes out.
    const { camera } = fx;
    fx.stop();
    fx = null;
    update({ local: new MediaStream([...(call.value?.local?.getAudioTracks() ?? []), camera]), effect: undefined, bg: undefined });
    await sender.replaceTrack(camera).catch(() => {});
    return;
  }
  if (v.effectLoading || (!fx && !next.effect && !next.bg)) return;
  update({ effectLoading: true });
  const camera = fx?.camera ?? v.local?.getVideoTracks()[0];
  try {
    if (fx) {
      await fx.set(next);
      if (call.value?.id === v.id) update(shown(next));
      return;
    }
    if (!camera) return;
    const started = await startEffects(camera, next, (why) => {
      void setLook({ effect: null, bg: null });
      showToast(t(why === 'slow' ? 'fx.slow' : 'fx.failed'));
    });
    const now = call.value;
    // The call ended, the camera changed or a screen went in while loading.
    if (!now || now.id !== v.id || now.screen || now.local?.getVideoTracks()[0] !== camera) {
      started.stop();
      return;
    }
    fx = started;
    hint(new MediaStream([fx.track]));
    // Loaded while the app was in the background: the bare camera until it is back.
    await sender.replaceTrack(document.hidden ? camera : fx.track);
    update({ local: new MediaStream([...(now.local?.getAudioTracks() ?? []), fx.track]), ...shown(next) });
  } catch {
    // A camera switched or turned off while loading is not a failure.
    if (camera?.readyState !== 'ended') showToast(t('fx.failed'));
  } finally {
    update({ effectLoading: false });
  }
}

export const setEffect = (effect: EffectId | null) => setLook({ effect });
export const setBackground = (bg: BgId | null) => setLook({ bg });

// toggleCamera really stops the camera when off (its light goes out) and
// starts it again when on; the other side shows our avatar meanwhile.
export async function toggleCamera() {
  const v = call.value;
  const sender = senderOf('video');
  if (!v || !sender || v.screen) return;
  try {
    if (v.camOff) {
      await useCamera();
      if (pc) void senders(pc); // the new track gets the video caps
      if (!v.video) {
        update({ video: true }); // a voice call turns into a video call
        audioSession('auto'); // loudspeaker, as in a video call
        void keepAwake();
      }
    } else {
      dropEffects();
      await sender.replaceTrack(null);
      v.local?.getVideoTracks().forEach((tr) => tr.stop());
      update({ local: new MediaStream(v.local?.getAudioTracks() ?? []), effect: undefined, bg: undefined });
    }
    update({ camOff: !v.camOff });
    sendState();
  } catch (e) {
    // A camera busy in another app must not end the call.
    const name = (e as DOMException)?.name;
    showToast(name === 'NotAllowedError' || name === 'NotFoundError' || name === 'NotReadableError' ? t('call.noMedia') : errText(e));
  }
}

// switchCamera flips between the front and the back camera (phones);
// selectCamera picks one by name from the devices menu. While the screen
// is shown, the choice waits for the camera to come back.
export async function switchCamera() {
  // From the camera in use: one picked by name may face either way.
  const now = call.value?.local?.getVideoTracks()[0]?.getSettings().facingMode;
  facing = (now === 'environment' || now === 'user' ? now : facing) === 'user' ? 'environment' : 'user';
  camId = '';
  remember('callCam', '');
  try {
    await useCamera();
  } catch (e) {
    showToast(errText(e));
  }
}

export async function selectCamera(deviceId: string) {
  camId = deviceId;
  remember('callCam', deviceId);
  const v = call.value;
  if (!v || v.camOff || v.screen) return;
  try {
    await useCamera();
  } catch (e) {
    showToast(errText(e));
  }
}

// Screen sharing (computers): the screen goes out in the camera's slot, so
// nothing is renegotiated. The camera stops meanwhile (its light goes out)
// and comes back when sharing ends, by our button or the browser's own
// "Stop sharing".
export const canShareScreen = !mobile && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
let camBefore = false; // the camera was on when sharing began

export async function shareScreen() {
  const v = call.value;
  const sender = senderOf('video');
  if (!v || !sender || v.screen) return;
  let s: MediaStream;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
  } catch (e) {
    // Cancelled in the browser's own picker: nothing to say.
    if ((e as DOMException)?.name !== 'NotAllowedError') showToast(t('call.screenFailed'));
    return;
  }
  const track = s.getVideoTracks()[0];
  track.contentHint = 'detail'; // text stays sharp: frames drop before resolution
  const now = call.value;
  if (!now || now.id !== v.id) return track.stop(); // the call ended while choosing
  // Taken off the hidden-page handler first: sharing a tab hides this page,
  // and the handler would put the camera back over the screen.
  const effects = fx;
  fx = null;
  try {
    await sender.replaceTrack(track);
  } catch (e) {
    fx = effects;
    track.stop();
    return showToast(errText(e));
  }
  camBefore = !now.camOff;
  effects?.stop();
  effects?.camera.stop();
  now.local?.getVideoTracks().forEach((tr) => tr.stop());
  track.addEventListener('ended', () => void stopScreen());
  update({ local: new MediaStream([...(now.local?.getAudioTracks() ?? []), track]), screen: true, camOff: false, effect: undefined, bg: undefined });
  if (!now.video) {
    update({ video: true });
    void keepAwake();
  }
  if (pc) void senders(pc);
  sendState();
}

export async function stopScreen() {
  const v = call.value;
  if (!v?.screen) return;
  v.local?.getVideoTracks().forEach((tr) => tr.stop());
  update({ local: new MediaStream(v.local?.getAudioTracks() ?? []), screen: false, camOff: true });
  sendState(); // the other side stops showing the last frame at once
  if (camBefore) {
    try {
      await useCamera();
      if (call.value?.id !== v.id || call.value.screen) return;
      update({ camOff: false });
      return sendState();
    } catch {
      if (call.value?.id === v.id) showToast(t('call.noMedia'));
    }
  }
  await senderOf('video')
    ?.replaceTrack(null)
    .catch(() => {});
  sendState();
}

// selectMic swaps the microphone mid-call. On Android this is also how a
// call moves between the earpiece and the speakerphone: Chrome lists them
// as microphones, and picking one routes the whole call there.
export async function selectMic(deviceId: string) {
  const v = call.value;
  const sender = senderOf('audio');
  if (!v || !sender) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC, deviceId: { exact: deviceId } } });
    hint(s);
    const track = s.getAudioTracks()[0];
    track.enabled = !v.muted;
    await sender.replaceTrack(track);
    const now = call.value?.local;
    now?.getAudioTracks().forEach((tr) => tr.stop());
    update({ local: new MediaStream([track, ...(now?.getVideoTracks() ?? [])]) });
    remember('callMic', deviceId);
  } catch (e) {
    showToast(errText(e));
  }
}

export function selectSpeaker(deviceId: string) {
  speaker.value = deviceId;
  remember('callSpeaker', deviceId);
}

// Mid-call renegotiation. Errors here never end the call: the retry loop
// in lost() tries again.
async function onReoffer(v: CallView, ev: Record<string, unknown>) {
  if (!pc || caller) return;
  peerDevice = ev.dev as number;
  await pc.setRemoteDescription(JSON.parse(await openSignal(v.chat, ev.e as number, v.id, 'reoffer', ev.body as string)));
  await localDescription(pc, await pc.createAnswer());
  const { e, body } = await sealSignal(v.chat, v.id, 'reanswer', JSON.stringify(pc.localDescription));
  wsSend({ t: 'call', k: 'reanswer', c: v.chat, id: v.id, to: peerDevice, e, body });
  await flushIce();
}

async function onReanswer(v: CallView, ev: Record<string, unknown>) {
  if (!pc || !caller || pc.signalingState !== 'have-local-offer') return;
  await pc.setRemoteDescription(JSON.parse(await openSignal(v.chat, ev.e as number, v.id, 'reanswer', ev.body as string)));
  await flushIce();
}

async function onSignal(ev: Record<string, unknown>) {
  let v = call.value;
  const id = ev.id as string;
  try {
    switch (ev.k) {
      case 'offer':
        if (!findChat(ev.c as number)) {
          // Opened from the call push: the offer beats the chat list here.
          await appReady;
          if (!findChat(ev.c as number) || ended.has(id)) return;
          v = call.value;
        }
        if (v) {
          if (v.id !== id) wsSend({ t: 'call', k: 'busy', c: ev.c, id, to: ev.dev });
          return;
        }
        offer = { body: ev.body as string, e: ev.e as number, dev: ev.dev as number };
        caller = false;
        socketHold.call = true;
        call.value = { id, chat: ev.c as number, peer: ev.from as number, video: !!ev.v, phase: 'incoming', muted: false, camOff: !ev.v };
        stopTone = ringtone();
        navigator.vibrate?.([400, 200, 400]);
        ringTimer = setTimeout(cleanup, RING_MS);
        // Answered from the notification before the call reached this page
        // (it opened, or woke, from the tap): pick it up.
        const asked = await idbGet<{ id: string; at: number } | null>('answer');
        if (asked?.id === id && Date.now() - asked.at < RING_MS) {
          void idbSet('answer', null);
          return void accept(true);
        }
        if (notifyHere()) {
          const name = findChat(ev.c as number)?.members.find((m) => m.id === ev.from)?.name ?? '';
          void notifyCall(ev.c as number, id, name, t(ev.v ? 'call.incomingVideo' : 'call.incomingAudio'), t('call.accept'), t('call.decline'));
        }
        return;
      case 'answer':
        // Only the first answer counts (the server lets one through too).
        if (!v || v.id !== id || pc?.signalingState !== 'have-local-offer') return;
        quiet();
        peerDevice = ev.dev as number;
        update({ phase: 'connecting' });
        await pc.setRemoteDescription(JSON.parse(await openSignal(v.chat, ev.e as number, id, 'answer', ev.body as string)));
        await flushIce();
        return;
      case 'ice': {
        if (!v || v.id !== id || !pc) return;
        const c = JSON.parse(await openSignal(v.chat, ev.e as number, id, 'ice', ev.body as string));
        // A candidate of an older ICE generation is refused: harmless.
        if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
        else inIce.push(c);
        return;
      }
      case 'reoffer':
        if (v?.id === id) await onReoffer(v, ev).catch(() => {});
        return;
      case 'reanswer':
        if (v?.id === id) await onReanswer(v, ev).catch(() => {});
        return;
      case 'restart':
        if (v?.id === id && caller) await renegotiate();
        return;
      case 'hangup':
      case 'decline':
      case 'busy':
        if (!v || v.id !== id) return void ended.add(id);
        if (ev.k === 'decline') outcome = 'declined';
        if (ev.k === 'busy') outcome = 'busy';
        finish();
        return;
      case 'taken': // answered or declined on another of my devices
        if (v?.id === id && !caller && (v.phase === 'incoming' || v.phase === 'connecting')) cleanup();
        else ended.add(id);
        return;
    }
  } catch {
    if (v?.id === id) hangup('failed');
  }
}

// Signals are handled one at a time, in order: a candidate of the new
// network must not overtake the re-offer it belongs to.
let queue = Promise.resolve();
setCallHandler((e) => {
  queue = queue.then(() => onSignal(e));
});

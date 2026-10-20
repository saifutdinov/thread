import { signal } from '@preact/signals';
import { api } from './api';
import { rand, toB64u } from './crypto';
import { refreshDevices, remember, remembered } from './devices';
import { errText, t } from './i18n';
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

// Sounds are synthesized: no audio files to ship. A note is a pitch (Hz),
// a start and a length (s). Bell notes ring out with a soft overtone, like
// a marimba; the others hold steady, like a phone line's tone.
interface Note {
  f: number;
  at: number;
  len: number;
  bell?: boolean;
}

// play repeats notes every `every` seconds (once when 0) until stopped.
// Each note fades in and out, so nothing clicks.
function play(notes: Note[], every: number, gain = 0.07): () => void {
  const ac = new AudioContext();
  ac.resume().catch(() => {}); // iOS may start a context suspended outside a tap
  let timer: ReturnType<typeof setTimeout> | undefined;
  const voice = (f: number, at: number, len: number, level: number, bell: boolean) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.01);
    if (bell) g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    else {
      g.gain.setValueAtTime(level, at + len - 0.05);
      g.gain.linearRampToValueAtTime(0, at + len);
    }
    o.connect(g).connect(ac.destination);
    o.start(at);
    o.stop(at + len + 0.05);
  };
  const once = () => {
    const t0 = ac.currentTime + 0.05;
    for (const n of notes) {
      voice(n.f, t0 + n.at, n.len, gain, !!n.bell);
      if (n.bell) voice(n.f * 4, t0 + n.at, n.len / 4, gain / 8, true);
    }
    if (every) timer = setTimeout(once, every * 1000);
  };
  once();
  const stop = () => {
    clearTimeout(timer);
    ac.close().catch(() => {});
  };
  if (!every) setTimeout(stop, (Math.max(...notes.map((n) => n.at + n.len)) + 0.3) * 1000);
  return stop;
}

const E5 = 659.25, GS5 = 830.61, B5 = 987.77, E6 = 1318.51, G5 = 783.99, C5 = 523.25;
// Waiting for an answer: the familiar 425 Hz line tone, 0.8 s every 4 s.
const ringback = () => play([{ f: 425, at: 0, len: 0.8 }], 4, 0.05);
// Incoming: a rising E major arpeggio, answered by a short phrase.
const ringtone = () =>
  play(
    [
      { f: E5, at: 0, len: 0.7, bell: true },
      { f: GS5, at: 0.15, len: 0.7, bell: true },
      { f: B5, at: 0.3, len: 0.7, bell: true },
      { f: E6, at: 0.45, len: 1.1, bell: true },
      { f: B5, at: 1.2, len: 0.6, bell: true },
      { f: E6, at: 1.35, len: 1.2, bell: true },
    ],
    3.2,
  );
// The call is over: two falling notes.
const hangupTone = () =>
  play(
    [
      { f: G5, at: 0, len: 0.4, bell: true },
      { f: C5, at: 0.16, len: 0.7, bell: true },
    ],
    0,
  );

function quiet() {
  stopTone?.();
  stopTone = null;
  clearTimeout(ringTimer);
}

const CAMERA = (facingMode: 'user' | 'environment'): MediaTrackConstraints => ({
  facingMode,
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
    video: video ? CAMERA('user') : false,
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
  const b = battery && { level: Math.round(battery.level * 100), charging: battery.charging };
  if (v && state?.readyState === 'open') state.send(JSON.stringify({ camOff: v.camOff, muted: v.muted, battery: b }));
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
  return typeof level === 'number' && level >= 0 && level <= 100 && typeof charging === 'boolean' ? { level, charging } : undefined;
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
      update({ peerCamOff: m.camOff === true, peerMuted: m.muted === true, peerBattery: peerBattery(m.battery) });
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
  call.value?.local?.getTracks().forEach((tr) => tr.stop());
  pc?.close();
  pc = null;
  peerDevice = 0;
  outIce = [];
  inIce = [];
  offer = null;
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

let facing: 'user' | 'environment' = 'user';

// useCamera puts a fresh camera track (the current facing) into the call and
// the self view; the previous one is stopped.
async function useCamera(): Promise<void> {
  const v = call.value;
  const sender = senderOf('video');
  if (!v || !sender) return;
  const s = await navigator.mediaDevices.getUserMedia({ video: CAMERA(facing) });
  hint(s);
  const track = s.getVideoTracks()[0];
  await sender.replaceTrack(track);
  const now = call.value?.local;
  now?.getVideoTracks().forEach((tr) => tr.stop());
  update({ local: new MediaStream([...(now?.getAudioTracks() ?? []), track]) });
}

// toggleCamera really stops the camera when off (its light goes out) and
// starts it again when on; the other side shows our avatar meanwhile.
export async function toggleCamera() {
  const v = call.value;
  const sender = senderOf('video');
  if (!v || !sender) return;
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
      await sender.replaceTrack(null);
      v.local?.getVideoTracks().forEach((tr) => tr.stop());
      update({ local: new MediaStream(v.local?.getAudioTracks() ?? []) });
    }
    update({ camOff: !v.camOff });
    sendState();
  } catch (e) {
    // A camera busy in another app must not end the call.
    const name = (e as DOMException)?.name;
    showToast(name === 'NotAllowedError' || name === 'NotFoundError' || name === 'NotReadableError' ? t('call.noMedia') : errText(e));
  }
}

export async function switchCamera() {
  facing = facing === 'user' ? 'environment' : 'user';
  try {
    await useCamera();
  } catch (e) {
    showToast(errText(e));
  }
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

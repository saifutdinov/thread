import { signal } from '@preact/signals';
import type { LocalVideoTrack, Participant, RemoteTrack, Room, VideoTrack } from 'livekit-client';
import { api, ApiError, type RunningCall } from './api';
import { rand, toB64u } from './crypto';
import { remember, remembered } from './devices';
import { errText, t } from './i18n';
import { idbGet, idbSet } from './idb';
import { latest, micConstraints, type Mic, openMic, wantsProcessing } from './mic';
import { hangupTone, playSound } from './sounds';
import { me, openSignal, releaseSocket, sealSignal, sendCallLog, setGroupHandler, showToast, socketHold } from './store';

// Group calls (docs/adr/0002-group-calls.md): up to 10 people through the
// LiveKit SFU next to the server. Every frame is encrypted here with the
// call key before it leaves (LiveKit's E2EE worker), so the SFU forwards
// ciphertext. The key is random per call, sealed with the chat key by the
// one who starts it; the server keeps only that ciphertext and hands it
// to members who join. 1:1 calls stay device to device (call.ts).

export interface Person {
  id: string; // LiveKit identity "<user>.<device>"
  user: number;
  me: boolean;
  speaking: boolean;
  muted: boolean;
  video?: VideoTrack; // a camera that is on and reaches us
  screen?: VideoTrack; // their shared screen
}

export interface GroupView {
  chat: number;
  id: string;
  phase: 'incoming' | 'connecting' | 'active';
  from?: number; // who rings
  video: boolean; // the call was started as a video call
  muted: boolean;
  camOff: boolean;
  people: Person[];
  since?: number;
  reconnecting?: boolean;
  needsTap?: boolean; // the browser holds the sound back until a tap
  sharing?: boolean; // my screen is shared
}

export const groupCall = signal<GroupView | null>(null);
export const groupCallsOn = signal(false);
export const runningCalls = signal<Map<number, RunningCall>>(new Map());

const RING_MS = 45_000;
const CROWD = 5; // from this many people on, a newcomer comes in muted
let lk: typeof import('livekit-client') | null = null; // loaded on the first group call
let room: Room | null = null;
let worker: Worker | null = null; // LiveKit's E2EE worker holds the call key: ours to stop
let gmic: Mic | null = null; // the microphone we publish, perhaps processed
// Every join and every end bumps it: a join that sees another number by
// the time its await returns was cancelled (a hang-up while connecting).
let attempt = 0;
// The running call's sealed key: puts the call back on a server that
// restarted and forgot it.
let joined: { chat: number; id: string; e: number; key: string; v: boolean } | null = null;
let ringTimer: ReturnType<typeof setTimeout> | undefined;
let stopTone: (() => void) | null = null;
const audioBox = document.createElement('div'); // remote sound plays from <audio> elements kept here
audioBox.hidden = true;
document.body.append(audioBox);

const update = (patch: Partial<GroupView>) => {
  if (groupCall.value) groupCall.value = { ...groupCall.value, ...patch };
};

const userOf = (identity: string) => Number(identity.split('.')[0]) || 0;

function quiet() {
  stopTone?.();
  stopTone = null;
  clearTimeout(ringTimer);
}

function setRunning(c: RunningCall) {
  const m = new Map(runningCalls.value);
  if (c.users.length) m.set(c.c, c);
  else m.delete(c.c);
  runningCalls.value = m;
}

setGroupHandler((e) => {
  if (e.t === 'open') return void reopen();
  const chat = e.c as number;
  if (e.k === 'state') {
    const users = (e.users as number[]) ?? [];
    setRunning({ c: chat, id: e.id as string, v: !!e.v, users });
    // Everyone left before we picked up, or we picked up on another device: stop ringing.
    const g = groupCall.value;
    if (g?.phase === 'incoming' && g.chat === chat && (!users.length || users.includes(me.value?.user.id ?? 0))) end();
    return;
  }
  if (e.k === 'ring') {
    // Busy in a call already (this one, another, or 1:1): the banner in the chat stays.
    if (groupCall.value || socketHold.call || e.from === me.value?.user.id) return;
    groupCall.value = { chat, id: e.id as string, phase: 'incoming', from: e.from as number, video: !!e.v, muted: false, camOff: true, people: [] };
    stopTone = playSound('ring');
    navigator.vibrate?.([400, 200, 400]);
    ringTimer = setTimeout(end, RING_MS);
  }
});

// "Join" on a group call's notification (sw.js): an open app joins at once;
// one the tap opened joins once it knows the running calls (reopen). Either
// way the note is used up, so a later reconnect does not join again.
// A call this app does not know of yet (a phone back from the background,
// its list from before) keeps the note for the list the new socket brings.
let joining = false;
async function pendingJoin(chat?: number) {
  if (joining) return; // both ways at once: one join
  joining = true;
  try {
    const j = await idbGet<{ c: number; at: number } | null>('gjoin').catch(() => null);
    if (!j || Date.now() - j.at > 60_000 || (chat !== undefined && j.c !== chat) || !runningCalls.value.has(j.c)) return;
    await idbSet('gjoin', null).catch(() => {});
    await startGroupCall(j.c, false);
  } finally {
    joining = false;
  }
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.t === 'gjoin') void pendingJoin(e.data.c);
});

// A new socket: the running calls (an app that just opened shows their
// banners), and back into ours, which the server dropped with the old one.
async function reopen() {
  try {
    const r = await api.groupCalls();
    groupCallsOn.value = r.on;
    runningCalls.value = new Map(r.calls.map((c) => [c.c, c]));
    void pendingJoin();
    const j = joined;
    if (j && groupCall.value?.phase === 'active') {
      const back = await api.joinGroupCall(j.chat, { ...j, rejoin: true });
      // Someone started a new call while this one was forgotten: ours is not it.
      if (back.id !== j.id) {
        showToast(t('gcall.moved'));
        void leave();
      }
    }
  } catch {
    /* the next socket tries again */
  }
}

// startGroupCall joins the chat's running call, or starts one with a new
// key. Whoever is first wins a race: the server answers with its call.
export async function startGroupCall(chat: number, video: boolean) {
  if (room || socketHold.call || (groupCall.value && groupCall.value.phase !== 'incoming')) return;
  const { isE2EESupported } = await import('livekit-client');
  if (!isE2EESupported()) return void showToast(t('gcall.unsupported'));
  quiet();
  const my = ++attempt;
  const stale = () => my !== attempt;
  socketHold.call = true;
  groupCall.value = { chat, id: '', phase: 'connecting', video, muted: false, camOff: !video, people: [] };
  try {
    let body: Parameters<typeof api.joinGroupCall>[1] = {};
    // Joining a call that already has five people: in it muted, to listen first.
    const crowded = (runningCalls.value.get(chat)?.users.length ?? 0) >= CROWD;
    if (!runningCalls.value.has(chat)) {
      const id = toB64u(rand(12));
      const sealed = await sealSignal(chat, id, 'gkey', toB64u(rand(32)));
      body = { id, v: video, e: sealed.e, key: sealed.body };
    }
    const j = await api.joinGroupCall(chat, body);
    // Hung up while joining: our leave may have reached the server first.
    if (stale()) return void api.leaveGroupCall(chat).catch(() => {});
    joined = { chat, id: j.id, e: j.e, key: j.key, v: j.v };
    const key = await openSignal(chat, j.e, j.id, 'gkey', j.key);
    if (stale()) return;
    update({ id: j.id });
    // Ours is the call (no race lost): it goes into the chat, without a push.
    if (body.id && j.id === body.id) sendCallLog(chat, { v: video, d: 0, s: 'ok', g: j.id }).catch(() => {});
    await enter(j.url, j.token, key, video, stale, crowded);
  } catch (e) {
    if (stale()) return;
    showToast(e instanceof ApiError && e.code === 'call_full' ? t('gcall.full') : errText(e));
    void leave();
  }
}

// enter connects to LiveKit with frame encryption on. Every await may be
// a hang-up: a cancelled attempt opens nothing and closes what it opened.
async function enter(path: string, token: string, key: string, video: boolean, stale: () => boolean, muted = false) {
  lk = await import('livekit-client');
  const { default: E2EEWorker } = await import('livekit-client/e2ee-worker?worker');
  if (stale()) return;
  const keyProvider = new lk.ExternalE2EEKeyProvider();
  await keyProvider.setKey(key);
  if (stale()) return;
  const w = new E2EEWorker();
  worker = w;
  const mic = remembered('callMic');
  const cam = remembered('callCam');
  const r = new lk.Room({
    adaptiveStream: true, // pictures off screen or small are fetched small, or not at all
    dynacast: true, // nobody watches a layer: it is not sent
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, deviceId: mic || undefined }, // only if ours below failed
    videoCaptureDefaults: { resolution: lk.VideoPresets.h540.resolution, facingMode: 'user', deviceId: cam || undefined },
    // DTX: most people are silent most of the time. No RED: it doubles the
    // sound for every listener and does not pass the frame encryption.
    publishDefaults: { dtx: true, red: false, audioPreset: { maxBitrate: 32_000 }, simulcast: true, videoSimulcastLayers: [lk.VideoPresets.h180, lk.VideoPresets.h360] },
    encryption: { keyProvider, worker: w },
  });
  room = r;
  const refresh = () =>
    room === r &&
    update({
      people: people(r),
      muted: !r.localParticipant.isMicrophoneEnabled,
      camOff: !r.localParticipant.isCameraEnabled,
      sharing: r.localParticipant.isScreenShareEnabled,
    });
  const E = lk.RoomEvent;
  for (const ev of [
    E.ParticipantConnected,
    E.ParticipantDisconnected,
    E.TrackSubscribed,
    E.TrackUnsubscribed,
    E.TrackPublished,
    E.TrackUnpublished, // after the publication is gone: a stopped screen leaves no empty tile
    E.TrackMuted,
    E.TrackUnmuted,
    E.ActiveSpeakersChanged,
    E.LocalTrackPublished,
    E.LocalTrackUnpublished,
  ])
    r.on(ev, refresh);
  r.on(E.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind !== 'audio') return;
    const el = track.attach();
    audioBox.append(el);
    const sink = remembered('callSpeaker');
    if (sink && 'setSinkId' in el) (el as HTMLAudioElement).setSinkId(sink).catch(() => {});
  });
  r.on(E.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()));
  r.on(E.Reconnecting, () => update({ reconnecting: true }));
  r.on(E.Reconnected, () => update({ reconnecting: false }));
  r.on(E.AudioPlaybackStatusChanged, () => update({ needsTap: !r.canPlaybackAudio }));
  r.on(E.EncryptionError, () => showToast(t('gcall.encryption')));
  r.on(E.Disconnected, () => {
    if (room === r) void leave(); // the server closed it, or the network is gone for good
  });
  const drop = () => {
    void r.disconnect();
    w.terminate();
  };
  await r.setE2EEEnabled(true);
  await r.connect(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`, token);
  if (stale()) return drop();
  update({ phase: 'active', since: Date.now(), needsTap: !r.canPlaybackAudio });
  try {
    const own = await processedMic(mic || undefined);
    if (stale()) own?.close();
    else if (own) {
      await publishMic(r, own);
      if (muted) await r.localParticipant.setMicrophoneEnabled(false);
    } else if (!muted) await r.localParticipant.setMicrophoneEnabled(true);
    if (muted && !stale()) showToast(t('gcall.joinedMuted', { n: CROWD }));
    if (video && !stale()) await r.localParticipant.setCameraEnabled(true);
  } catch {
    if (!stale()) showToast(t('call.noMedia')); // in the call anyway: listening works without a microphone
  }
  if (stale()) return drop(); // the microphone must not stay on after a hang-up
  refresh();
}

function people(r: Room): Person[] {
  const all: Participant[] = [r.localParticipant, ...r.remoteParticipants.values()];
  const { Camera, Microphone, ScreenShare } = lk!.Track.Source;
  return all.map((p) => {
    const cam = p.getTrackPublication(Camera);
    const mic = p.getTrackPublication(Microphone);
    const scr = p.getTrackPublication(ScreenShare);
    const on = cam && !cam.isMuted && cam.videoTrack;
    return {
      id: p.identity,
      user: userOf(p.identity),
      me: p === r.localParticipant,
      speaking: p.isSpeaking,
      muted: !mic || mic.isMuted,
      video: on ? cam.videoTrack : undefined,
      screen: (scr && !scr.isMuted && scr.videoTrack) || undefined,
    };
  });
}

export function decline() {
  end();
}

// processedMic opens the microphone through mic.ts when this device
// processes it (noise suppression, the voice gate). Null: LiveKit opens it
// itself, as without processing, and so reopens it when it ends (a phone
// call, an unplugged headset); a track of ours it would only mute.
async function processedMic(deviceId?: string): Promise<Mic | null> {
  if (!wantsProcessing()) return null;
  const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId ? { ideal: deviceId } : undefined) });
  const m = await openMic(s.getAudioTracks()[0]);
  if (m.track !== m.raw) return m;
  m.close(); // processing failed to start
  return null;
}

async function publishMic(r: Room, m: Mic) {
  gmic = m;
  m.raw.addEventListener('ended', () => void reopenGroupMic()); // the device is gone: the default one
  await r.localParticipant.publishTrack(m.track, { source: lk!.Track.Source.Microphone });
}

// reopenGroupMic opens the microphone again with the processing as now
// chosen: a new publication, ours or LiveKit's, muted as before.
export const reopenGroupMic = latest(async () => {
  const r = room;
  const p = r?.localParticipant;
  if (!p || !lk) return;
  const pub = p.getTrackPublication(lk.Track.Source.Microphone);
  const muted = !p.isMicrophoneEnabled;
  try {
    // The one picked in the call's settings, else the one in use.
    const own = await processedMic(remembered('callMic') || (gmic?.raw ?? pub?.track?.mediaStreamTrack)?.getSettings().deviceId);
    if (room !== r) return own?.close();
    if (!own && !gmic) return; // LiveKit's microphone already, and it stays
    if (pub?.track) await p.unpublishTrack(pub.track);
    gmic?.close();
    gmic = null;
    if (room !== r) return own?.close();
    if (own) {
      await publishMic(r, own);
      if (muted) await p.setMicrophoneEnabled(false);
    } else if (!muted) await p.setMicrophoneEnabled(true);
  } catch (e) {
    showToast(errText(e));
  }
});

// groupDevices: the microphone and camera the call uses now, for its settings.
export function groupDevices(): { mic?: string; cam?: string } {
  const p = room?.localParticipant;
  if (!p || !lk) return {};
  const { Camera, Microphone } = lk.Track.Source;
  const mic = gmic?.raw ?? p.getTrackPublication(Microphone)?.track?.mediaStreamTrack;
  const cam = p.getTrackPublication(Camera)?.track?.mediaStreamTrack;
  return { mic: mic?.getSettings().deviceId, cam: (cam?.readyState === 'live' && cam.getSettings().deviceId) || remembered('callCam') };
}

// selectGroupMic and selectGroupCamera switch devices mid-call, remembered as
// in a 1:1 call. A processed microphone (ours) opens again on the new one;
// LiveKit's own it switches itself, the camera too, and the speakers.
export async function selectGroupMic(id: string) {
  remember('callMic', id);
  if (gmic) return reopenGroupMic();
  await room?.switchActiveDevice('audioinput', id).catch((e) => showToast(errText(e)));
}

export async function selectGroupCamera(id: string) {
  remember('callCam', id);
  await room?.switchActiveDevice('videoinput', id).catch((e) => showToast(errText(e)));
  update({ people: room ? people(room) : [] });
}

export const selectGroupSpeaker = (id: string) => room?.switchActiveDevice('audiooutput', id).catch(() => {});

// toggleGroupScreen shares the screen as a track of its own, frame-encrypted
// like the camera (computers only: canShareScreen), with its sound when it
// is ticked in the picker: stereo, unprocessed, no DTX (quiet passages of
// music are not silence). Closing the browser's own "Stop sharing" ends it
// too; LiveKit unpublishes it then.
// restrictOwnAudio: the whole screen's sound without this page's own (the call).
const SCREEN_SOUND = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, restrictOwnAudio: true };
export async function toggleGroupScreen() {
  const p = room?.localParticipant;
  if (!p || !lk) return;
  await p
    .setScreenShareEnabled(
      !p.isScreenShareEnabled,
      { audio: SCREEN_SOUND, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' },
      { audioPreset: lk.AudioPresets.musicHighQualityStereo, dtx: false, red: false, forceStereo: true },
    )
    // Closing the picker is NotAllowedError "Permission denied"; macOS without
    // the system's screen recording permission is one too, "by system".
    .catch((e: DOMException) => (e?.name !== 'NotAllowedError' || /system/i.test(e.message)) && showToast(t('call.screenFailed')));
  update({ sharing: p.isScreenShareEnabled, people: room ? people(room) : [] });
}

export async function toggleGroupMute() {
  const p = room?.localParticipant;
  if (!p) return;
  await p.setMicrophoneEnabled(!p.isMicrophoneEnabled).catch(() => showToast(t('call.noMedia')));
  update({ muted: !p.isMicrophoneEnabled });
}

export async function toggleGroupCamera() {
  const p = room?.localParticipant;
  if (!p) return;
  await p.setCameraEnabled(!p.isCameraEnabled).catch(() => showToast(t('call.noMedia')));
  update({ camOff: !p.isCameraEnabled, people: room ? people(room) : [] });
}

// flipGroupCamera: the front or the back camera (phones).
export async function flipGroupCamera() {
  const pub = lk && room?.localParticipant.getTrackPublication(lk.Track.Source.Camera);
  const track = pub?.videoTrack as LocalVideoTrack | undefined;
  if (!track) return;
  const now = track.mediaStreamTrack.getSettings().facingMode;
  await track.restartTrack({ facingMode: now === 'environment' ? 'user' : 'environment' }).catch((e) => showToast(errText(e)));
}

// startAudio: the browser held the sound back (no tap yet on this page).
export const startGroupAudio = () => void room?.startAudio().then(() => update({ needsTap: false }));

export async function leave() {
  const g = groupCall.value;
  const r = room;
  const w = worker;
  room = null;
  worker = null;
  joined = null;
  end();
  await r?.disconnect();
  w?.terminate();
  if (g && g.phase !== 'incoming') {
    hangupTone();
    await api.leaveGroupCall(g.chat).catch(() => {});
  }
}

function end() {
  attempt++;
  quiet();
  gmic?.close();
  gmic = null;
  audioBox.replaceChildren();
  const was = !!groupCall.value && groupCall.value.phase !== 'incoming';
  groupCall.value = null;
  if (was) {
    socketHold.call = false;
    releaseSocket();
  }
}

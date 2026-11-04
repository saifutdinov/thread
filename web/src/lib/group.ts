import { signal } from '@preact/signals';
import type { LocalVideoTrack, Participant, RemoteAudioTrack, RemoteParticipant, RemoteTrack, Room, VideoTrack } from 'livekit-client';
import { api, ApiError, type RunningCall } from './api';
import { rand, toB64u } from './crypto';
import { remember, remembered } from './devices';
import { beginDiagnostics, downloadDiagnostics } from './diagnostics';
import { errText, t } from './i18n';
import { idbGet, idbSet } from './idb';
import { latest } from './latest';
import { CallPresence } from './call-presence';
import { cancelMicRequest, type MicRequest, micConstraints, type Mic, openMic, pushToTalk, wantsProcessing } from './mic';
import { hangupTone, playSound } from './sounds';
import { me, openSignal, releaseSocket, sealSignal, sendCallLog, setGroupHandler, showToast, socketHold } from './store';

import { NetworkPolicy, type NetworkMode, type NetworkQuality } from './network-policy';
import { networkMode, rememberNetworkMode } from './network';

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
  screenSound?: boolean; // screen sound or separately shared music
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
  networkReduced?: boolean;
  needsTap?: boolean; // the browser holds the sound back until a tap
  sharing?: boolean; // my screen is shared
  playerMusic?: boolean; // the app's player plays into the call (shareGroupMusic)
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
let history: ReturnType<typeof beginDiagnostics> | null = null;
let desiredMute = false;
let micStarting: Room | null = null; // capture/publication owns microphone creation until it settles
let micReopen: Room | null = null; // settings changed while the initial capture was pending
const pendingMicrophones = new Set<MicRequest>();
function cancelMicrophone(request: MicRequest) {
  cancelMicRequest(request);
  pendingMicrophones.delete(request);
}
const networkPolicy = new NetworkPolicy();
let networkTimer: ReturnType<typeof setInterval> | undefined;
let cameraBlocked = false;
let screenBlocked = false;
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
  if (e.t === 'open') { history?.mark('signaling-open'); return void reopen(); }
  if (e.t === 'close') { history?.mark('signaling-close'); return; }
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
    const j = await idbGet<{ c: number; id?: string; at: number } | null>('gjoin').catch(() => null);
    if (!j || Date.now() - j.at > 60_000 || (chat !== undefined && j.c !== chat) || !runningCalls.value.has(j.c)) return;
    if (j.id !== runningCalls.value.get(j.c)?.id) return;
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
  history = beginDiagnostics('group');
  history.mark('starting');
  const stale = () => my !== attempt;
  socketHold.call = true;
  cameraBlocked = screenBlocked = false;
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
  networkPolicy.reset();
  const crowded = muted;
  muted ||= pushToTalk.value;
  desiredMute = muted;
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
  micStarting = r;
  const refresh = () =>
    room === r &&
    update({
      people: people(r),
      muted: desiredMute || !r.localParticipant.isMicrophoneEnabled,
      camOff: !r.localParticipant.isCameraEnabled,
      sharing: r.localParticipant.isScreenShareEnabled,
    });
  const presence = new CallPresence(playSound);
  const baseline = () => presence.start(r.remoteParticipants.keys(), r.localParticipant.identity);
  const E = lk.RoomEvent;
  let quality: NetworkQuality | undefined;
  let networkReconnecting = false;
  const readQuality = (q = r.localParticipant.connectionQuality) => {
    quality = q === 'poor' || q === 'lost' ? 'poor' : q === 'excellent' || q === 'good' ? 'good' : undefined;
  };
  const lostQuality = () => { networkReconnecting = true; quality = undefined; networkPolicy.observe(networkMode.value); };
  r.on(E.Reconnecting, lostQuality);
  r.on(E.SignalReconnecting, lostQuality);
  const sampleNetwork = () => {
    if (room !== r) return;
    const reduced = networkPolicy.observe(networkMode.value, networkReconnecting ? undefined : quality);
    const changed = !!groupCall.value?.networkReduced !== reduced;
    if (changed) {
      update({ networkReduced: reduced });
      if (reduced && networkMode.value === 'auto') showToast(t('call.networkAutoReduced'));
    }
    if (changed || reduced) applyGroupNetwork(r, reduced);
  };
  r.on(E.ConnectionQualityChanged, (q, participant) => {
    if (participant !== r.localParticipant) return;
    readQuality(q);
    sampleNetwork();
  });
  r.on(E.Reconnected, () => {
    if (room !== r) return;
    networkReconnecting = false;
    readQuality(); // unchanged quality does not emit ConnectionQualityChanged again
    sampleNetwork();
  });
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
  const capNewCamera = () => { if (room === r && groupCall.value?.networkReduced) applyGroupNetwork(r, true); };
  r.on(E.TrackSubscribed, capNewCamera);
  r.on(E.TrackSubscribed, (track: RemoteTrack, pub, participant) => {
    if (room === r) playRemote(track, pub, participant);
  });
  r.on(E.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()));
  // A full SDK restart removes participants before emitting Reconnecting.
  // Wait until that synchronous event batch finishes before making a sound.
  r.on(E.ParticipantConnected, (p) => queueMicrotask(() => { if (room === r) presence.joined(p.identity); }));
  r.on(E.ParticipantDisconnected, (p) => queueMicrotask(() => { if (room === r) presence.left(p.identity); }));
  r.on(E.SignalReconnecting, () => presence.pause());
  r.on(E.Reconnecting, () => presence.pause());
  r.on(E.Reconnected, () => { if (room === r) baseline(); });
  const gateMic = () => {
    if (room !== r || !desiredMute) return;
    const track = r.localParticipant.getTrackPublication(lk!.Track.Source.Microphone)?.track?.mediaStreamTrack;
    if (track) track.enabled = false;
    if (gmic) gmic.raw.enabled = gmic.track.enabled = false;
  };
  r.on(E.TrackUnmuted, gateMic);
  r.on(E.LocalTrackPublished, gateMic);
  const trace = history;
  r.on(E.Reconnecting, () => { if (room === r) { trace?.mark('reconnecting'); update({ reconnecting: true }); } });
  r.on(E.Reconnected, () => { if (room === r) { trace?.mark('reconnected'); update({ reconnecting: false }); } });
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
  readQuality();
  sampleNetwork();
  networkTimer = setInterval(sampleNetwork, 2000);
  update({ phase: 'active', since: Date.now(), needsTap: !r.canPlaybackAudio, muted: desiredMute });
  trace?.mark('connected', { participants: r.remoteParticipants.size + 1 });
  let micReady = false;
  baseline();
  playSound('join');
  const request: MicRequest = { controller: new AbortController() };
  pendingMicrophones.add(request);
  try {
    trace?.mark('media-request');
    const own = await processedMic(request, mic || undefined);
    if (stale()) own?.close();
    else if (own) {
      await publishMic(r, own);
    } else if (!desiredMute) {
      await r.localParticipant.setMicrophoneEnabled(true);
    }
    micReady = true;
    trace?.mark('media-ready');
    if (crowded && desiredMute && !stale()) showToast(t('gcall.joinedMuted', { n: CROWD }));
    if (video && !stale() && !cameraBlocked) {
      await r.localParticipant.setCameraEnabled(true);
      if (stale() || cameraBlocked) await r.localParticipant.setCameraEnabled(false);
    }
  } catch {
    if (!stale()) showToast(t('call.noMedia')); // in the call anyway: listening works without a microphone
  } finally {
    if (request.mic !== gmic) cancelMicrophone(request);
    pendingMicrophones.delete(request);
    if (room === r && !stale()) {
      micStarting = null;
      if (micReopen === r) {
        micReopen = null;
        await reopenGroupMic();
      }
      // Even when capture was skipped on a muted join, an unmute made
      // while the camera opened must take effect. Do not retry a failed
      // microphone permission automatically.
      if (room === r && (micReady || desiredMute)) await setGroupMuted(desiredMute);
    }
  }
  if (stale()) return drop(); // the microphone must not stay on after a hang-up
  refresh();
}

function applyGroupNetwork(r: Room, reduced: boolean) {
  if (room !== r || !lk) return;
  const quality = reduced ? lk.VideoQuality.LOW : lk.VideoQuality.HIGH;
  // Incoming max quality composes with adaptiveStream. Leave publishing
  // layers to SDK bandwidth control/dynacast, including its fully idle state.
  for (const p of r.remoteParticipants.values()) for (const pub of p.videoTrackPublications.values()) {
    if (pub.isSubscribed && pub.source === lk.Track.Source.Camera) pub.setVideoQuality(quality);
  }
}
export function selectGroupNetworkMode(mode: NetworkMode) {
  rememberNetworkMode(mode);
  if (!room) return;
  const reduced = networkPolicy.observe(mode);
  update({ networkReduced: reduced });
  applyGroupNetwork(room, reduced);
}
export async function stopGroupVideo() {
  const r = room;
  cameraBlocked = screenBlocked = true;
  update({ camOff: true, sharing: false });
  if (!r) return;
  await Promise.all([r.localParticipant.setScreenShareEnabled(false), r.localParticipant.setCameraEnabled(false)]);
  if (room !== r) return;
  update({ camOff: !r.localParticipant.isCameraEnabled, sharing: r.localParticipant.isScreenShareEnabled, people: people(r) });
}

function people(r: Room): Person[] {
  const all: Participant[] = [r.localParticipant, ...r.remoteParticipants.values()];
  const { Camera, Microphone, ScreenShare, ScreenShareAudio, Unknown } = lk!.Track.Source;
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
      screenSound: [...(p.audioTrackPublications?.values() ?? [])].some((pub) => (pub.source === ScreenShareAudio || pub.source === Unknown) && !pub.isMuted),
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
async function processedMic(request: MicRequest, deviceId?: string): Promise<Mic | null> {
  const hold = pushToTalk.value;
  if (!wantsProcessing() && !hold) return null;
  const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId ? { ideal: deviceId } : undefined) });
  request.raw = s.getAudioTracks()[0];
  if (request.controller.signal.aborted) { s.getTracks().forEach((track) => track.stop()); throw request.controller.signal.reason; }
  const m = await openMic(request.raw, request.controller.signal);
  request.mic = m;
  if (request.controller.signal.aborted) { m.close(); throw request.controller.signal.reason; }
  // Raw can be intentional (off/AEC/AGC) or a bounded native fallback. Keep
  // its capture constraints instead of replacing it with LiveKit defaults.
  return m;
}

async function publishMic(r: Room, m: Mic) {
  m.raw.enabled = m.track.enabled = !desiredMute;
  gmic = m;
  m.raw.addEventListener('ended', () => void reopenGroupMic()); // the device is gone: the default one
  try {
    await r.localParticipant.publishTrack(m.track, { source: lk!.Track.Source.Microphone });
  } catch (e) {
    if (gmic === m) gmic = null;
    m.close();
    throw e;
  }
}

// reopenGroupMic opens the microphone again with the processing as now
// chosen: a new publication, ours or LiveKit's, muted as before.
export const reopenGroupMic = latest(async () => {
  const r = room;
  const p = r?.localParticipant;
  if (!p || !lk) return;
  if (micStarting === r) {
    micReopen = r;
    return;
  }
  const pub = p.getTrackPublication(lk.Track.Source.Microphone);
  const previousMic = gmic;
  micStarting = r;
  let own: Mic | null = null;
  const request: MicRequest = { controller: new AbortController() };
  pendingMicrophones.add(request);
  let opened = false;
  try {
    // The one picked in the call's settings, else the one in use.
    own = await processedMic(request, remembered('callMic') || (previousMic?.raw ?? pub?.track?.mediaStreamTrack)?.getSettings().deviceId);
    if (room !== r) return own?.close();
    if (!own && !gmic) {
      await r.switchActiveDevice('audioinput', remembered('callMic') || 'default');
      return; // already using LiveKit's microphone, with the latest input
    }
    if (pub?.track) await p.unpublishTrack(pub.track);
    if (room !== r) return own?.close();
    previousMic?.close();
    gmic = null;
    if (own) {
      await publishMic(r, own);
      opened = true;
    } else {
      await r.switchActiveDevice('audioinput', remembered('callMic') || 'default');
      if (room !== r) return;
      if (!desiredMute) {
        await p.setMicrophoneEnabled(true);
        opened = true;
      }
    }
  } catch (e) {
    own?.close();
    if (gmic === own) gmic = null;
    if (room === r) showToast(errText(e));
  } finally {
    if (request.mic !== gmic) cancelMicrophone(request);
    pendingMicrophones.delete(request);
    if (room === r) {
      micStarting = null;
      if (opened || desiredMute) await setGroupMuted(desiredMute);
    }
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
  if (gmic || (room && micStarting === room)) return reopenGroupMic();
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
  const r = room;
  const p = r?.localParticipant;
  if (!p || !lk) return;
  screenBlocked = p.isScreenShareEnabled;
  await p
    .setScreenShareEnabled(
      !p.isScreenShareEnabled,
      { audio: SCREEN_SOUND, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' },
      { audioPreset: lk.AudioPresets.musicHighQualityStereo, dtx: false, red: false, forceStereo: true },
    )
    // Closing the picker is NotAllowedError "Permission denied"; macOS without
    // the system's screen recording permission is one too, "by system".
    .catch((e: DOMException) => (e?.name !== 'NotAllowedError' || /system/i.test(e.message)) && showToast(t('call.screenFailed')));
  if (room !== r || screenBlocked) await p.setScreenShareEnabled(false).catch(() => {});
  if (room === r) update({ sharing: p.isScreenShareEnabled, people: people(r!) });
}

// shareGroupMusic publishes the app's player (player.ts musicTrack) as a
// track of its own, frame-encrypted like the others, stereo and
// unprocessed like a screen's sound; every app plays each audio track it
// gets, so older ones hear it too.
let music: MediaStreamTrack | null = null;
export async function shareGroupMusic(track: MediaStreamTrack) {
  const p = room?.localParticipant;
  if (!p || !lk || groupCall.value?.phase !== 'active') return track.stop();
  await stopGroupMusic();
  music = track;
  try {
    await p.publishTrack(track, {
      name: 'music',
      source: lk.Track.Source.Unknown,
      audioPreset: lk.AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: false,
      forceStereo: true,
    });
  } catch (e) {
    if (music === track) music = null;
    track.stop();
    return showToast(errText(e));
  }
  if (music !== track) return; // stopped meanwhile
  update({ playerMusic: true });
  showToast(t('music.headphones'));
}

export async function stopGroupMusic() {
  const tr = music;
  if (!tr) return;
  music = null;
  await room?.localParticipant.unpublishTrack(tr, true).catch(() => {});
  tr.stop();
  update({ playerMusic: false });
}

export async function toggleGroupMute() {
  await setGroupMuted(!groupCall.value?.muted);
}

let muteQueue = Promise.resolve();
export function setGroupMuted(muted: boolean) {
  history?.mark(muted ? 'mic-muted' : 'mic-unmuted');
  const r = room;
  desiredMute = muted;
  if (r) update({muted});
  // Stop the current track immediately on release, even while LiveKit is
  // still opening/unmuting it. Queue operations so a late unmute cannot win.
  const track = lk && r?.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track?.mediaStreamTrack;
  if (track && muted) track.enabled = false;
  if (gmic && muted) gmic.raw.enabled = gmic.track.enabled = false;
  if (!r || micStarting === r) return Promise.resolve();
  muteQueue = muteQueue.catch(() => {}).then(async () => {
    if (!r || room !== r) return;
    const p = r.localParticipant;
    await p.setMicrophoneEnabled(!desiredMute).catch(() => { if (room === r) showToast(t('call.noMedia')); });
    const now = lk && p.getTrackPublication(lk.Track.Source.Microphone)?.track?.mediaStreamTrack;
    if (room !== r) return;
    if (now) now.enabled = !desiredMute;
    if (gmic) gmic.raw.enabled = gmic.track.enabled = !desiredMute;
    update({muted: desiredMute || !p.isMicrophoneEnabled});
  });
  return muteQueue;
}

export const participantVolumes = signal(new Map<string, number>());
export const screenVolumes = signal(new Map<string, number>());
function saveVolume(state: { value: Map<string, number> }, identity: string, volume: number) {
  const next = new Map(state.value);
  next.delete(identity);
  next.set(identity, volume);
  // Bound histories even if many devices join/leave one long-running call.
  if (next.size > 100) next.delete(next.keys().next().value!);
  state.value = next;
}
export function setParticipantVolume(identity: string, value: number) {
  if (!Number.isFinite(value) || !room?.remoteParticipants.has(identity)) return;
  const volume = Math.max(0, Math.min(1, value));
  saveVolume(participantVolumes, identity, volume);
  room?.remoteParticipants.get(identity)?.setVolume(volume);
}

// LiveKit owns voice/screen levels and their subscription cache. The app's
// player is published as Unknown, which the participant API does not cover.
function applyMusicVolume(participant: RemoteParticipant) {
  const volume = screenVolumes.value.get(participant.identity) ?? 1;
  for (const pub of participant.audioTrackPublications.values()) {
    if (pub.source === lk!.Track.Source.Unknown) (pub.audioTrack as RemoteAudioTrack | undefined)?.setVolume(volume);
  }
}
export function setScreenVolume(identity: string, value: number) {
  const participant = room?.remoteParticipants.get(identity);
  if (!participant || !Number.isFinite(value)) return;
  const volume = Math.max(0, Math.min(1, value));
  saveVolume(screenVolumes, identity, volume);
  participant.setVolume(volume, lk!.Track.Source.ScreenShareAudio);
  applyMusicVolume(participant);
}

// After a full reconnect the participant is a new object: restore both SDK
// caches, including zero, before attach. Unknown music uses the same stream level.
function playRemote(track: RemoteTrack, _pub: unknown, participant: RemoteParticipant) {
  if (track.kind !== 'audio') return;
  participant.setVolume(participantVolumes.value.get(participant.identity) ?? 1);
  participant.setVolume(screenVolumes.value.get(participant.identity) ?? 1, lk!.Track.Source.ScreenShareAudio);
  if (track.source === lk!.Track.Source.Unknown) (track as RemoteAudioTrack).setVolume(screenVolumes.value.get(participant.identity) ?? 1);
  const el = track.attach();
  audioBox.append(el);
  const sink = remembered('callSpeaker');
  if (sink && 'setSinkId' in el) (el as HTMLAudioElement).setSinkId(sink).catch(() => {});
}

export async function exportGroupDiagnostics() {
  const r = room;
  if (!r) return;
  const tracks = [r.localParticipant, ...r.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()].flatMap((pub) => pub.track ? [pub.track] : []));
  const reports = (await Promise.all(tracks.map((track) => track.getRTCStatsReport().catch(() => undefined)))).filter((s): s is RTCStatsReport => !!s);
  if (room === r) downloadDiagnostics('group', reports, {connection: r.state, participants: r.remoteParticipants.size + 1, encrypted: r.isE2EEEnabled}, history?.snapshot());
}

export async function toggleGroupCamera() {
  const r = room;
  const p = r?.localParticipant;
  if (!p) return;
  cameraBlocked = p.isCameraEnabled;
  await p.setCameraEnabled(!p.isCameraEnabled).catch(() => showToast(t('call.noMedia')));
  if (room !== r || cameraBlocked) await p.setCameraEnabled(false).catch(() => {});
  if (room === r) update({ camOff: !p.isCameraEnabled, people: people(r!) });
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
  if (history) {
    const tracks = r ? [r.localParticipant, ...r.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()].flatMap((pub) => pub.track ? [pub.track] : [])) : [];
    history.finish(Promise.all(tracks.map((tr) => tr.getRTCStatsReport().catch(() => undefined))).then((reports) => reports.filter((r): r is RTCStatsReport => !!r)), { encrypted: r?.isE2EEEnabled ?? true });
    history = null;
  }
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
  for (const request of pendingMicrophones) cancelMicrophone(request);
  pendingMicrophones.clear();
  clearInterval(networkTimer);
  networkTimer = undefined;
  networkPolicy.reset();
  attempt++;
  muteQueue = Promise.resolve();
  desiredMute = true;
  micStarting = null;
  micReopen = null;
  quiet();
  gmic?.close();
  gmic = null;
  music?.stop();
  music = null;
  audioBox.replaceChildren();
  participantVolumes.value = new Map();
  screenVolumes.value = new Map();
  const was = !!groupCall.value && groupCall.value.phase !== 'incoming';
  groupCall.value = null;
  if (was) {
    socketHold.call = false;
    releaseSocket();
  }
}

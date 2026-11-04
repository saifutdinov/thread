import { NetworkPolicy, videoBudget } from './network-policy.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { latest } from './latest.ts';
import { CallPresence } from './call-presence.ts';

function groupCode() {
  const source = readFileSync(new URL('./group.ts', import.meta.url), 'utf8');
  return stripTypeScriptTypes(
    source
      .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
      .replaceAll("await import('livekit-client')", 'testLiveKit')
      .replace("await import('livekit-client/e2ee-worker?worker')", '({default: TestWorker})'),
  ).replace(/\bexport\s+/g, '');
}

test('a notification join survives an old running-call list until its exact room arrives', async () => {
  let note: unknown = { c: 7, id: 'new', at: Date.now() };
  const starts: number[] = [];
  const context = vm.createContext({
    runningCalls: { value: new Map() },
    idbGet: async () => note,
    idbSet: async (_: string, value: unknown) => {
      note = value;
    },
    startGroupCall: async (chat: number) => {
      starts.push(chat);
    },
  });
  const source = readFileSync(new URL('./group.ts', import.meta.url), 'utf8');
  const pending = stripTypeScriptTypes(source.slice(source.indexOf('let joining = false;'), source.indexOf('navigator.serviceWorker?.addEventListener')));
  vm.runInContext(pending + '\nglobalThis.subject={pendingJoin,runningCalls};', context);
  const s = context.subject as { pendingJoin: (c?: number) => Promise<void>; runningCalls: { value: Map<number, unknown> } };
  s.runningCalls.value.set(7, { id: 'old' });
  await s.pendingJoin(7);
  assert.ok(note, 'stale list must not consume the new room intent');
  assert.deepEqual(starts, []);
  s.runningCalls.value.set(7, { id: 'new' });
  await s.pendingJoin();
  assert.equal(note, null);
  assert.deepEqual(starts, [7]);
  await s.pendingJoin();
  assert.deepEqual(starts, [7], 'intent is consumed once');
});

test('holding push-to-talk while the initial group microphone opens does not start a second capture or mute the held microphone', async () => {
  let allow!: (stream: unknown) => void;
  const permission = new Promise((resolve) => (allow = resolve));
  const raw = {
    enabled: true,
    stop() {
      this.enabled = false;
    },
    addEventListener() {},
  };
  const output = { ...raw };
  const enabled: boolean[] = [],
    toasts: string[] = [];
  let publication: { track: { mediaStreamTrack: typeof raw } } | undefined;
  const participant = {
    identity: '1.1',
    isMicrophoneEnabled: false,
    isCameraEnabled: false,
    getTrackPublication: (source: string) => (source === 'mic' ? publication : undefined),
    publishTrack: async (track: typeof raw) => {
      publication = { track: { mediaStreamTrack: track } };
      participant.isMicrophoneEnabled = true;
    },
    setMicrophoneEnabled: async (value: boolean) => {
      enabled.push(value);
      participant.isMicrophoneEnabled = value;
      if (publication) publication.track.mediaStreamTrack.enabled = value;
    },
  };
  class Room {
    localParticipant = participant;
    remoteParticipants = new Map();
    canPlaybackAudio = true;
    on() {
      return this;
    }
    async setE2EEEnabled() {}
    async connect() {}
  }
  const context = vm.createContext({
    CallPresence, queueMicrotask, playSound: () => () => {},
    signal: (value: unknown) => ({ value }),
    beginDiagnostics: () => ({ mark() {}, snapshot: () => [], finish() {} }),
    latest: (f: unknown) => f,
    setInterval: () => 0, clearInterval() {},
    NetworkPolicy, videoBudget, networkMode: {value:'auto'}, rememberNetworkMode() {},
    document: { createElement: () => ({}), body: { append() {} } },
    navigator: { mediaDevices: { getUserMedia: () => permission } },
    location: { protocol: 'http:', host: 'localhost' },
    setGroupHandler() {},
    remembered: () => '',
    pushToTalk: { value: true },
    wantsProcessing: () => true,
    micConstraints: () => ({}),
    openMic: async () => ({ raw, track: output, close: () => raw.stop() }),
    testLiveKit: {
      Room,
      RoomEvent: {},
      Track: { Source: { Microphone: 'mic' } }, VideoQuality: {LOW:0,HIGH:2},
      VideoPresets: { h540: { resolution: {} }, h180: {}, h360: {} },
      ExternalE2EEKeyProvider: class {
        async setKey() {}
      },
    },
    TestWorker: class {
      terminate() {}
    },
    t: (key: string) => key,
    showToast: (text: string) => toasts.push(text),
  });
  vm.runInContext(groupCode() + '\nglobalThis.subject={enter,setGroupMuted,groupCall};', context);
  const s = (
    context as unknown as {
      subject: {
        enter: (path: string, token: string, key: string, video: boolean, stale: () => boolean) => Promise<void>;
        setGroupMuted: (v: boolean) => Promise<void>;
        groupCall: { value: unknown };
      };
    }
  ).subject;
  s.groupCall.value = { phase: 'connecting', people: [] };
  const joining = s.enter('/lk', 'token', 'key', false, () => false);
  await new Promise((resolve) => setImmediate(resolve));
  await s.setGroupMuted(false); // button held while permission/processing is pending
  assert.deepEqual(enabled, [], 'must not ask LiveKit to capture a second microphone');
  allow({ getAudioTracks: () => [raw] });
  await joining;
  assert.equal(output.enabled, true, 'initial muted flag must not override the current held state');
  assert.deepEqual(toasts, [], 'push-to-talk is not the five-person auto-mute condition');
  await s.setGroupMuted(true);
  assert.equal(output.enabled, false);
});

test('a cancelled group microphone replacement cannot close the next call microphone', async () => {
  let finish!: () => void,
    unpublishing = false,
    nextClosed = 0,
    candidateClosed = 0;
  const pending = new Promise<void>((resolve) => (finish = resolve));
  const raw = { getSettings: () => ({}), addEventListener() {}, enabled: true };
  const own = {
    raw,
    track: { ...raw },
    close: () => {
      candidateClosed++;
    },
  };
  const context = vm.createContext({
    CallPresence, queueMicrotask, playSound: () => () => {},
    signal: (value: unknown) => ({ value }),
    beginDiagnostics: () => ({ mark() {}, snapshot: () => [], finish() {} }),
    latest: (f: unknown) => f,
    setInterval: () => 0, clearInterval() {},
    NetworkPolicy, videoBudget, networkMode: {value:'auto'}, rememberNetworkMode() {},
    document: { createElement: () => ({}), body: { append() {} } },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getAudioTracks: () => [raw] }),
      },
    },
    setGroupHandler() {},
    remembered: () => '',
    pushToTalk: { value: false },
    wantsProcessing: () => true,
    micConstraints: () => ({}),
    openMic: async () => own,
    t: String,
    showToast() {},
    errText: String,
  });
  vm.runInContext(
    groupCode() + '\nglobalThis.subject={reopenGroupMic,init(r,m){room=r;gmic=m;lk={Track:{Source:{Microphone:"mic"}}};}};',
    context,
  );
  const s = (
    context as unknown as {
      subject: {
        init: (r: unknown, m: unknown) => void;
        reopenGroupMic: () => Promise<void>;
        stopGroupVideo: () => Promise<void>;
      };
    }
  ).subject;
  const oldMic = { raw, close() {} };
  s.init(
    {
      localParticipant: {
        isMicrophoneEnabled: true,
        getTrackPublication: () => ({ track: { mediaStreamTrack: raw } }),
        unpublishTrack: () => {
          unpublishing = true;
          return pending;
        },
      },
    },
    oldMic,
  );
  const replacement = s.reopenGroupMic();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unpublishing, true);
  s.init(
    { localParticipant: {} },
    {
      raw,
      close: () => {
        nextClosed++;
      },
    },
  );
  finish();
  await replacement;
  assert.equal(nextClosed, 0);
  assert.equal(candidateClosed, 1);
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function startup(processing: boolean, crowded = false) {
  const sounds: string[] = [];
  const handlers = new Map<string, ((p?: unknown) => void)[]>();
  const events = { ParticipantConnected: 'joined', ParticipantDisconnected: 'left', Reconnecting: 'reconnecting', Reconnected: 'reconnected', SignalReconnecting: 'signal-reconnecting' };
  let joinedRoom!: Room;
  let selected = 'old-mic';
  const tracks: {
    deviceId: string;
    enabled: boolean;
    closed: boolean;
    getSettings: () => { deviceId: string };
    addEventListener: () => void;
  }[] = [];
  const captures: { id: string; finish: () => void }[] = [];
  const track = (deviceId: string) => {
    const tr = {
      deviceId,
      enabled: true,
      closed: false,
      getSettings: () => ({ deviceId: tr.deviceId }),
      addEventListener() {},
    };
    tracks.push(tr);
    return tr;
  };
  let publication: { track: { mediaStreamTrack: ReturnType<typeof track> } } | undefined;
  let finishCamera!: () => void;
  const camera = new Promise<void>((resolve) => {
    finishCamera = resolve;
  });
  const participant = {
    identity: '1.1',
    isMicrophoneEnabled: false,
    isCameraEnabled: false,
    getTrackPublication: (source: string) => (source === 'mic' ? publication : undefined),
    publishTrack: async (tr: ReturnType<typeof track>) => {
      publication = { track: { mediaStreamTrack: tr } };
      participant.isMicrophoneEnabled = true;
    },
    unpublishTrack: async () => {
      publication = undefined;
      participant.isMicrophoneEnabled = false;
    },
    setMicrophoneEnabled: async (on: boolean) => {
      if (on && !publication) publication = { track: { mediaStreamTrack: track(selected) } };
      participant.isMicrophoneEnabled = on;
      if (publication) publication.track.mediaStreamTrack.enabled = on;
    },
    setCameraEnabled: (_on: boolean) => camera,
  };
  class Room {
    constructor() { joinedRoom = this; }
    localParticipant = participant;
    remoteParticipants = new Map();
    canPlaybackAudio = true;
    on(event: string, fn: (p?: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return this;
    }
    async setE2EEEnabled() {}
    async connect() {}
    async switchActiveDevice(_kind: string, id: string) {
      selected = id;
      if (publication) publication.track.mediaStreamTrack.deviceId = id;
    }
  }
  const state = { processing };
  const choices = { callMic: 'old-mic' };
  const context = vm.createContext({
    CallPresence, queueMicrotask, playSound: (kind: string) => { sounds.push(kind); return () => {}; },
    signal: (value: unknown) => ({ value }),
    beginDiagnostics: () => ({ mark() {}, snapshot: () => [], finish() {} }),
    latest,
    setInterval: () => 0, clearInterval() {},
    NetworkPolicy, videoBudget, networkMode: {value:'auto'}, rememberNetworkMode() {},
    document: { createElement: () => ({}), body: { append() {} } },
    navigator: {
      mediaDevices: {
        getUserMedia: (constraints: { audio: { deviceId?: { ideal: string } } }) =>
          new Promise((resolve) => {
            const id = constraints.audio.deviceId?.ideal ?? 'default';
            captures.push({
              id,
              finish: () => {
                const raw = track(id);
                resolve({ getAudioTracks: () => [raw] });
              },
            });
          }),
      },
    },
    location: { protocol: 'http:', host: 'localhost' },
    setGroupHandler() {},
    remembered: (key: keyof typeof choices) => choices[key] ?? '',
    remember: (key: keyof typeof choices, value: string) => {
      choices[key] = value;
    },
    pushToTalk: { value: false },
    wantsProcessing: () => state.processing,
    micConstraints: (deviceId: unknown) => ({ deviceId }),
    openMic: async (raw: ReturnType<typeof track>) => ({
      raw,
      track: { ...raw },
      close: () => {
        raw.closed = true;
      },
    }),
    testLiveKit: {
      Room,
      RoomEvent: {},
      Track: { Source: { Microphone: 'mic' } }, VideoQuality: {LOW:0,HIGH:2},
      VideoPresets: { h540: { resolution: {} }, h180: {}, h360: {} },
      ExternalE2EEKeyProvider: class {
        async setKey() {}
      },
    },
    TestWorker: class {
      terminate() {}
    },
    t: String,
    errText: String,
    showToast() {},
  });
  Object.assign((context.testLiveKit as { RoomEvent: object }).RoomEvent, events);
  vm.runInContext(groupCode() + '\nglobalThis.subject={enter,setGroupMuted,selectGroupMic,reopenGroupMic,groupCall};', context);
  vm.runInContext('globalThis.subject.stopGroupVideo=stopGroupVideo;', context);
  const s = (
    context as unknown as {
      subject: {
        enter: (p: string, t: string, k: string, v: boolean, stale: () => boolean, muted: boolean) => Promise<void>;
        setGroupMuted: (v: boolean) => Promise<void>;
        selectGroupMic: (id: string) => Promise<void>;
        reopenGroupMic: () => Promise<void>;
        stopGroupVideo: () => Promise<void>;
        groupCall: {
          value: { phase: string; people: unknown[]; muted?: boolean };
        };
      };
    }
  ).subject;
  s.groupCall.value = { phase: 'connecting', people: [] };
  const joining = s.enter('/lk', 'token', 'key', true, () => false, crowded);
  return {
    s,
    sounds, events, room: () => joinedRoom, emit: (event: string, p?: object) => handlers.get(event)?.forEach((fn) => fn(p)),
    joining,
    captures,
    tracks,
    finishCamera,
    state,
    participant,
    publication: () => publication,
  };
}

for (const early of [true, false]) test(`all-video-off ${early ? 'before SDK creation' : 'during microphone startup'} prevents a late group camera`, async () => {
  const h = startup(true);
  if (!early) await tick();
  const cameraRequests: boolean[] = [];
  h.participant.setCameraEnabled = async (on: boolean) => { cameraRequests.push(on); };
  Object.assign(h.participant, { setScreenShareEnabled: async () => {} });
  await h.s.stopGroupVideo();
  await tick();
  h.captures[0].finish(); h.finishCamera(); await h.joining;
  assert.deepEqual(cameraRequests, early ? [] : [false]);
});

test('unmute during camera startup is applied when a crowded join skipped initial microphone capture', async () => {
  const h = startup(false, true);
  await tick();
  await h.s.setGroupMuted(false);
  h.finishCamera();
  await h.joining;
  assert.equal(h.participant.isMicrophoneEnabled, true);
  assert.equal(h.s.groupCall.value.muted, false);
});

test('microphone selection made during initial capture is applied after startup', async () => {
  const h = startup(true);
  await tick();
  assert.equal(h.captures.length, 1);
  await h.s.selectGroupMic('new-mic');
  h.captures[0].finish();
  h.finishCamera();
  await tick();
  assert.equal(h.captures.length, 2, 'selection must request a new processed capture');
  assert.equal(h.captures[1].id, 'new-mic');
  h.captures[1].finish();
  await h.joining;
  assert.equal(h.tracks[0].closed, true);
  assert.equal(h.publication()?.track.mediaStreamTrack.deviceId, 'new-mic');
});

test('disabling processing during initial capture uses the latest device and mute intent', async () => {
  const h = startup(true);
  await tick();
  h.state.processing = false;
  await h.s.selectGroupMic('new-mic');
  await h.s.reopenGroupMic();
  await h.s.setGroupMuted(true);
  h.captures[0].finish();
  h.finishCamera();
  await h.joining;
  assert.equal(h.tracks[0].closed, true, 'outdated processed microphone must be closed');
  assert.equal(h.participant.isMicrophoneEnabled, false);
  await h.s.setGroupMuted(false);
  assert.equal(h.publication()?.track.mediaStreamTrack.deviceId, 'new-mic');
  assert.equal(h.captures.length, 1, 'disabled processing must use the SDK capture');
});


test('SDK full restart disconnect events before Reconnecting do not replay participant sounds', async () => {
  const h = startup(false);
  h.finishCamera(); await h.joining;
  const remote = { ...h.participant, identity: '2.1.other' };
  h.room().remoteParticipants.set(remote.identity, remote);
  h.emit(h.events.ParticipantConnected, remote); await tick();
  assert.deepEqual(h.sounds, ['join', 'join']);
  h.room().remoteParticipants.delete(remote.identity);
  h.emit(h.events.ParticipantDisconnected, remote);
  h.emit(h.events.Reconnecting);
  await tick();
  assert.deepEqual(h.sounds, ['join', 'join']);
  h.room().remoteParticipants.set(remote.identity, remote);
  h.emit(h.events.Reconnected); h.emit(h.events.ParticipantConnected, remote); await tick();
  assert.deepEqual(h.sounds, ['join', 'join']);
  h.room().remoteParticipants.delete(remote.identity);
  h.emit(h.events.ParticipantDisconnected, remote); await tick();
  assert.deepEqual(h.sounds, ['join', 'join', 'leave']);
});

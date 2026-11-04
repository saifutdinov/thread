import { NetworkPolicy, videoBudget } from './network-policy.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

// Exercise the actual browser state machine, replacing only its imports and
// browser API boundary. Deferred permissions reproduce cancellation races.
const source = readFileSync(new URL('./call.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')).replace(/\bexport\s+/g, '');
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function setup() {
  const serviceMessages: ((e: { data: Record<string, unknown> }) => void)[] = [];
  const requests: ReturnType<typeof deferred<Stream>>[] = [];
  const tracks: Track[] = [],
    peers: Peer[] = [],
    sent: Record<string, unknown>[] = [];
  let handler: (e: Record<string, unknown>) => void;
  let next = 0;
  class Track {
    kind = 'audio';
    enabled = true;
    readyState = 'live';
    addEventListener() {}
    stop() {
      this.readyState = 'ended';
    }
  }
  class Stream {
    tracks: Track[];
    constructor(tracks: Track[] = []) {
      this.tracks = tracks;
    }
    removeTrack(track: Track) { this.tracks = this.tracks.filter((t) => t !== track); }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t.kind === 'audio');
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t.kind === 'video');
    }
  }
  class Peer {
    transceivers: {
      receiver: { track: { kind: string } };
      sender: { track: null; replaceTrack: () => Promise<void> };
      direction: string;
    }[] = [];
    connectionState = 'new';
    onconnectionstatechange: (() => void) | null = null;
    closed = false;
    signalingState = 'stable';
    localDescription: unknown;
    remoteDescription: unknown;
    constructor() {
      peers.push(this);
    }
    addTrack(t: Track) {
      this.addTransceiver(t.kind);
    }
    addTransceiver(kind: string) {
      const tr = { receiver: { track: { kind } }, sender: { track: null, replaceTrack: async () => {} }, direction: 'sendrecv' };
      this.transceivers.push(tr);
      return tr;
    }
    getTransceivers() {
      return this.transceivers;
    }
    getSenders() {
      return [];
    }
    createDataChannel() {
      return { readyState: 'connecting' };
    }
    async createOffer() {
      return { type: 'offer', sdp: 'mock' };
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'mock' };
    }
    async setLocalDescription(d: { type: string }) {
      this.localDescription = d;
      this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(d: unknown) {
      this.remoteDescription = d;
      this.signalingState = 'stable';
    }
    async getStats() { return new Map(); }
    close() {
      this.closed = true;
    }
  }
  const sounds: string[] = [];
  const no = () => {};
  const sandbox = {
    signal: (value: unknown) => ({ value }),
    beginDiagnostics: () => ({ mark() {}, snapshot: () => [], finish() {} }),
    rand: () => new Uint8Array([++next]),
    toB64u: (b: Uint8Array) => `call-${b[0]}`,
    remembered: () => '',
    remember: no,
    refreshDevices: no,
    mobile: false,
    soundEvents: sounds,
    playSound: (kind: string) => { sounds.push(kind); return no; },
    hangupTone: () => sounds.push('leave'),
    pushToTalk: { value: false },
    errText: String,
    t: (x: string) => x,
    latest: (fn: unknown) => fn,
    micConstraints: () => ({}),
    openMic: async (raw: Track) => ({ raw, track: raw, close: () => raw.stop() }),
    groupCall: { value: null },
    declineGroup: no,
    clear: async () => {},
    notifyHere: () => false,
    notifyCall: no,
    videoOrder: () => ({ mobile: false, order: [] }),
    preferCodecs: (x: unknown) => x,
    tuneOpus: (x: unknown) => x,
    appReady: Promise.resolve(),
    findChat: () => ({ members: [] }),
    openSignal: async (_chat: number, _e: number, _id: string, kind: string) => JSON.stringify({ type: kind, sdp: 'mock' }),
    releaseSocket: no,
    sealSignal: async () => ({ e: 1, body: 'sealed' }),
    sendCallLog: async () => {},
    setCallHandler: (fn: typeof handler) => (handler = fn),
    showToast: no,
    socketHold: { call: false },
    wsSend: (e: Record<string, unknown>) => (sent.push(e), true),
    idbGet: async () => null,
    idbSet: async () => {},
    api: { turn: async () => ({ ice_servers: [] }) },
    navigator: {
      serviceWorker: { addEventListener: (_name: string, fn: (e: { data: Record<string, unknown> }) => void) => serviceMessages.push(fn) },
      userAgent: 'mock',
      mediaDevices: {
        getDisplayMedia: () => { const d = deferred<Stream>(); requests.push(d); return d.promise; },
        getUserMedia: () => {
          const d = deferred<Stream>();
          requests.push(d);
          return d.promise;
        },
      },
    },
    NetworkPolicy, videoBudget, networkMode: {value:'auto'}, rememberNetworkMode() {},
    document: { visibilityState: 'visible', addEventListener: no },
    addEventListener: no,
    MediaStream: Stream,
    RTCPeerConnection: Peer,
    RTCRtpReceiver: { getCapabilities: () => null },
    setTimeout: () => ++next,
    clearTimeout: no,
    setInterval: () => ++next,
    clearInterval: no,
    console,
    Date,
    Promise,
    Uint8Array,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(code + '\nglobalThis.subject = {startCall, accept, hangup, call, onSignal, stopOwnVideo, toggleCamera, shareScreen, prepareScreen(){camBefore=true;call.value={...call.value,phase:"active",screen:true,camOff:false};}};', context);
  const subject = (
    context as unknown as {
      subject: {
        startCall: (chat: number, peer: number, video: boolean) => Promise<void>;
        accept: (video: boolean) => Promise<void>;
        hangup: () => void;
        toggleCamera: () => Promise<void>; shareScreen: () => Promise<void>;
        stopOwnVideo: () => Promise<void>; prepareScreen: () => void;
        call: { value: { id: string; phase: string } | null };
        onSignal: (e: Record<string, unknown>) => Promise<void>;
      };
    }
  ).subject;
  const allow = (i = requests.length - 1, kind = 'audio', withAudio = false) => {
    const tr = new Track();
    tr.kind = kind;
    tracks.push(tr);
    const audio = withAudio ? new Track() : null;
    if (audio) tracks.push(audio);
    requests[i].resolve(new Stream(audio ? [audio, tr] : [tr]));
    return tr;
  };
  return { ...subject, sandbox, requests, allow, tracks, peers, sent, serviceMessages, tick: () => new Promise<void>((r) => setImmediate(r)) };
}

test('a stale notification action cannot accept or decline a different incoming call', async () => {
  const s = setup();
  await s.onSignal({ k: 'offer', id: 'current', c: 1, from: 2, dev: 20, e: 1, body: 'sealed' });
  for (const k of ['answer', 'decline']) s.serviceMessages.forEach((fn) => fn({ data: { t: 'call', k, id: 'old', c: 1 } }));
  assert.equal(s.call.value?.phase, 'incoming');
  assert.equal(s.requests.length, 0);
  s.serviceMessages.forEach((fn) => fn({ data: { t: 'call', k: 'answer', id: 'current', c: 1 } }));
  assert.equal(s.requests.length, 1);
  s.hangup();
  s.allow();
  await s.tick();
});

test('cancelled outgoing permissions leave no microphone, peer or offer', async () => {
  const s = setup();
  const pending = s.startCall(1, 2, false);
  s.hangup();
  const track = s.allow();
  await pending;
  assert.equal(track.readyState, 'ended');
  assert.equal(s.call.value, null);
  assert.equal(s.peers.length, 0);
  assert.equal(
    s.sent.some((e) => e.k === 'offer'),
    false,
  );
});

test('push-to-talk starts muted from live preferences even when storage cannot persist them', async () => {
  const s = setup();
  s.sandbox.pushToTalk.value = true;
  const start = s.startCall(1, 2, false);
  const track = s.allow();
  await start;
  assert.equal(track.enabled, false);
});

test('a direct call chimes once on connection, stays quiet on reconnect and chimes once on exit', async () => {
  const s = setup();
  const starting = s.startCall(1, 2, false);
  s.allow(); await starting;
  const peer = s.peers[0];
  peer.connectionState = 'connected'; peer.onconnectionstatechange!();
  peer.onconnectionstatechange!();
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange!();
  peer.connectionState = 'connected'; peer.onconnectionstatechange!();
  assert.equal(s.sandbox.soundEvents.filter((kind) => kind === 'join').length, 1);
  s.hangup(); s.hangup();
  assert.equal(s.sandbox.soundEvents.filter((kind) => kind === 'leave').length, 1);
});

test('a delayed notification lookup cannot ring after the incoming call was cancelled', async () => {
  const s = setup();
  const lookup = deferred<null>();
  let notifications = 0;
  s.sandbox.idbGet = async () => lookup.promise;
  s.sandbox.notifyHere = () => true;
  s.sandbox.notifyCall = () => {
    notifications++;
  };
  const incoming = s.onSignal({ k: 'offer', id: 'cancelled-ring', c: 1, from: 2, dev: 20, e: 1, body: 'sealed' });
  await s.tick();
  s.hangup();
  lookup.resolve(null);
  await incoming;
  assert.equal(notifications, 0);
});

test('cancelled incoming permissions leave no microphone, peer or answer', async () => {
  const s = setup();
  await s.onSignal({ k: 'offer', c: 1, id: 'incoming', dev: 10, from: 2, e: 1, body: 'sealed' });
  const pending = s.accept(false);
  s.hangup();
  const track = s.allow();
  await pending;
  assert.equal(track.readyState, 'ended');
  assert.equal(s.peers.length, 0);
  assert.equal(
    s.sent.some((e) => e.k === 'answer'),
    false,
  );
});

test('a cancelled TURN lookup cannot build a peer or end a newer call', async () => {
  const s = setup();
  const turn = deferred<{ ice_servers: never[] }>();
  s.sandbox.api.turn = () => turn.promise;
  const first = s.startCall(1, 2, false);
  const track = s.allow();
  await s.tick();
  s.hangup();
  s.sandbox.api.turn = async () => ({ ice_servers: [] });
  const second = s.startCall(3, 4, false);
  s.allow();
  await second;
  const id = s.call.value!.id;
  turn.resolve({ ice_servers: [] });
  await first;
  assert.equal(track.readyState, 'ended');
  assert.equal(s.call.value!.id, id);
  assert.equal(s.peers.length, 1);
  assert.equal(s.peers[0].closed, false);
});

test('a late error from cancelled permissions cannot close a new call', async () => {
  const s = setup();
  const first = s.startCall(1, 2, false);
  s.hangup();
  const second = s.startCall(3, 4, false);
  s.allow();
  await second;
  const id = s.call.value!.id;
  s.requests[0].reject(new Error('permission denied'));
  await first;
  assert.equal(s.call.value!.id, id);
  assert.equal(s.peers[0].closed, false);
});

test('late busy or hangup from an unselected device cannot end an answered call', async () => {
  const s = setup();
  const start = s.startCall(1, 2, false);
  s.allow();
  await start;
  const id = s.call.value!.id;
  await s.onSignal({ k: 'answer', id, c: 1, dev: 20, e: 1, body: 'sealed' });
  await s.onSignal({ k: 'busy', id, c: 1, dev: 21 });
  await s.onSignal({ k: 'hangup', id, c: 1, dev: 21 });
  assert.equal(s.call.value!.phase, 'connecting');
  await s.onSignal({ k: 'hangup', id, c: 1, dev: 20 });
  assert.equal(s.call.value, null);
  assert.equal(s.peers[0].closed, true);
});

for (const kind of ['answer', 'ice'])
  test(`late ${kind} decryption cannot touch the peer of a newer call`, async () => {
    const s = setup();
    const first = s.startCall(1, 2, false);
    s.allow();
    await first;
    const old = s.call.value!.id;
    const decrypt = deferred<string>();
    s.sandbox.openSignal = async () => decrypt.promise;
    const signal = s.onSignal({ k: kind, id: old, c: 1, dev: 20, e: 1, body: 'sealed' });
    await s.tick();
    s.hangup();
    const second = s.startCall(3, 4, false);
    s.allow();
    await second;
    const id = s.call.value!.id;
    decrypt.resolve(JSON.stringify({ type: kind, sdp: 'old' }));
    await signal;
    assert.equal(s.call.value!.id, id);
    assert.equal(s.peers[1].remoteDescription, undefined);
    assert.equal(s.peers[1].closed, false);
  });


test('turning off all own video does not reopen a camera when leaving screen share', async () => {
  const s=setup();
  const start=s.startCall(1,2,false);
  s.allow(); await start;
  s.prepareScreen();
  const off=s.stopOwnVideo();
  await s.tick();
  assert.equal(s.requests.length,1,'must not request camera access to turn video off');
  await off;
  s.hangup();
});


for (const action of ['toggleCamera', 'shareScreen'] as const) test(`all-video-off cancels a pending ${action} capture`, async () => {
  const s = setup();
  const start = s.startCall(1,2,false); s.allow(); await start;
  const opening = s[action]();
  await s.stopOwnVideo();
  const track = s.allow(1, 'video');
  await opening;
  assert.equal(track.readyState, 'ended');
  assert.equal((s.call.value as unknown as {camOff:boolean}).camOff, true);
  s.hangup();
});

test('cancelled initial video capture still negotiates a video slot that can send later', async () => {
  const s = setup();
  const opening = s.startCall(1, 2, true);
  await s.stopOwnVideo();
  const cancelled = s.allow(0, 'video', true);
  await opening;
  assert.equal(cancelled.readyState, 'ended');
  const video = s.peers[0].getTransceivers().find((tr) => tr.receiver.track.kind === 'video');
  assert.ok(video, 'the offer must retain a video slot even when permission was cancelled');
  const enabling = s.toggleCamera();
  assert.equal(s.requests.length, 2, 'later camera enable must actually request a track');
  const next = s.allow(1, 'video');
  await enabling;
  assert.equal(next.readyState, 'live');
  assert.equal((s.call.value as unknown as {camOff:boolean}).camOff, false);
  s.hangup();
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { rate } from './rtc.ts';
import { NetworkPolicy, type NetworkMode, type NetworkQuality, videoBudget } from './network-policy.ts';

test('unchanged RTC counters and disconnected transport do not count as healthy recovery', async () => {
  let packets = 10;
  const observed: (string | undefined)[] = [];
  const peer = {
    connectionState: 'connected',
    getStats: async () =>
      new Map<string, unknown>([
        ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', { type: 'candidate-pair', currentRoundTripTime: 0.05 }],
        ['audio', { type: 'inbound-rtp', kind: 'audio', bytesReceived: packets * 100, packetsReceived: packets, packetsLost: 0 }],
      ]),
  };
  const source = readFileSync(new URL('./call.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.slice(source.indexOf('async function sample()'), source.indexOf('async function flushIce()')));
  const context = vm.createContext({
    pc: peer,
    prev: null,
    rate,
    history: null,
    call: { value: { reconnecting: false } },
    update() {},
    updateNetwork: (q?: string) => observed.push(q),
    Date,
  });
  vm.runInContext(code + '\nglobalThis.sampleStats=sample;', context);
  const sample = context.sampleStats as () => Promise<void>;
  await sample();
  packets = 20;
  await sample();
  assert.equal(observed.at(-1), 'good');
  await sample();
  assert.equal(observed.at(-1), undefined, 'stale counters must break the recovery timer');
  packets = 30;
  peer.connectionState = 'disconnected';
  await sample();
  assert.equal(observed.at(-1), undefined);
});

test('economy changes video caps while preserving the music SDP bitrate and audio priorities', async () => {
  const music = {
    track: { kind: 'audio' },
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (p: unknown) => {
      parameters.push(p);
    },
  };
  const parameters: unknown[] = [];
  const peer = {
    getTransceivers: () => [
      { receiver: { track: { kind: 'audio' } }, sender: {} },
      { receiver: { track: { kind: 'audio' } }, sender: music },
    ],
    getSenders: () => [music],
  };
  const source = readFileSync(new URL('./call.ts', import.meta.url), 'utf8');
  const context = vm.createContext({
    pc: peer,
    musicSlot: () => ({ sender: music }),
    call: { value: { networkReduced: true } },
    videoBudget,
  });
  vm.runInContext(
    stripTypeScriptTypes(source.slice(source.indexOf('async function senders('), source.indexOf('const senderUpdates'))) +
      '\nglobalThis.send = senders; globalThis.normal=()=>{call.value.networkReduced=false;};',
    context,
  );
  await (context.send as (p: unknown) => Promise<void>)(peer);
  (context.normal as () => void)();
  await (context.send as (p: unknown) => Promise<void>)(peer);
  for (const p of parameters as { encodings: Record<string, unknown>[] }[]) {
    assert.equal(p.encodings[0].maxBitrate, undefined, 'music must retain its SDP limit in both modes');
    assert.equal(p.encodings[0].priority, 'medium');
  }
});

test('group recovery resumes from unchanged participant quality after reconnect', async () => {
  let now = 0,
    sample!: () => void;
  const handlers = new Map<string, (() => void)[]>();
  const qualities: number[] = [];
  const remote = new Map();
  const participant = {
    identity: '1.1',
    connectionQuality: 'excellent',
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    getTrackPublication() {},
    async setMicrophoneEnabled() {},
  };
  class Room {
    localParticipant = participant;
    remoteParticipants = remote;
    canPlaybackAudio = true;
    on(event: string, fn: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return this;
    }
    async setE2EEEnabled() {}
    async connect() {}
  }
  const source = readFileSync(new URL('./group.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(
    source
      .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
      .replaceAll("await import('livekit-client')", 'testLiveKit')
      .replace("await import('livekit-client/e2ee-worker?worker')", '({default:TestWorker})'),
  ).replace(/\bexport\s+/g, '');
  const context = vm.createContext({
    signal: (value: unknown) => ({ value }),
    document: { createElement: () => ({}), body: { append() {} } },
    navigator: {},
    location: { protocol: 'http:', host: 'localhost' },
    setGroupHandler() {},
    latest: (f: unknown) => f,
    NetworkPolicy: class extends NetworkPolicy {
      observe(mode: NetworkMode, q?: NetworkQuality) {
        return super.observe(mode, q, now);
      }
    },
    networkMode: { value: 'economy' },
    remembered: () => '',
    wantsProcessing: () => false,
    pushToTalk: { value: false },
    setInterval: (fn: () => void) => {
      sample = fn;
      return 1;
    },
    clearInterval() {},
    t: String,
    showToast() {},
    // The companion sounds PR adds participant chimes to enter(). This
    // network-only fixture replaces that unrelated output boundary too.
    playSound() {},
    CallPresence: class { start() {} pause() {} },
    testLiveKit: {
      Room,
      RoomEvent: {
        Reconnecting: 'reconnecting',
        SignalReconnecting: 'signalReconnecting',
        Reconnected: 'reconnected',
        ConnectionQualityChanged: 'quality',
      },
      Track: { Source: { Microphone: 'mic', Camera: 'camera' } },
      VideoQuality: { LOW: 0, HIGH: 2 },
      VideoPresets: { h540: { resolution: {} }, h180: {}, h360: {} },
      ExternalE2EEKeyProvider: class {
        async setKey() {}
      },
    },
    TestWorker: class {
      terminate() {}
    },
  });
  vm.runInContext(code + '\nglobalThis.s={enter,groupCall,auto(){networkMode.value="auto";}};', context);
  const s = context.s as { enter: (...args: unknown[]) => Promise<void>; groupCall: { value: unknown }; auto: () => void };
  s.groupCall.value = { phase: 'connecting', people: [] };
  await s.enter('/lk', 'token', 'key', false, () => false);
  remote.set('2.2', {
    videoTrackPublications: new Map([
      ['camera', { isSubscribed: true, source: 'camera', setVideoQuality: (q: number) => qualities.push(q) }],
    ]),
  });
  sample();
  assert.equal(qualities.at(-1), 0);
  s.auto();
  sample();
  now = 20_000;
  sample();
  for (const lost of handlers.get('reconnecting') ?? []) lost();
  now = 50_000;
  sample();
  assert.equal(qualities.at(-1), 0);
  for (const resumed of handlers.get('reconnected') ?? []) resumed();
  now = 79_999;
  sample();
  assert.equal(qualities.at(-1), 0);
  now = 80_000;
  sample();
  assert.equal(qualities.at(-1), 2, 'unchanged excellent must resume a new 30-second recovery period');
});

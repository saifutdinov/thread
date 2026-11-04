import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { DEFAULT_TUNE, length, repeats, TUNES } from './tunes.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function audio(fileExists: boolean, unavailable = false, fileDuration = 20) {
  let now = 0,
    next = 0,
    suspended = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const sources: {
    loop: boolean;
    started: boolean;
    stopped: boolean;
    buffer?: { duration: number; length: number };
    onended?: () => void;
  }[] = [];
  const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
  class Audio {
    constructor() {
      if (unavailable) throw new Error('audio unavailable');
    }
    state = 'running';
    currentTime = 0;
    destination = {};
    async resume() {
      this.state = 'running';
    }
    async suspend() {
      this.state = 'suspended';
      suspended++;
    }
    async decodeAudioData() {
      return {
        duration: fileDuration,
        numberOfChannels: 2,
        sampleRate: 100,
        length: fileDuration * 100,
        getChannelData: () => new Float32Array(fileDuration * 100).fill(0.25),
      };
    }
    createBuffer(channels: number, frames: number, sampleRate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        duration: frames / sampleRate,
        numberOfChannels: channels,
        sampleRate,
        length: frames,
        getChannelData: (ch: number) => data[ch],
        copyToChannel: (src: Float32Array, ch: number) => data[ch].set(src),
      };
    }
    createGain() {
      return {
        gain: { ...param },
        connect() {
          return this;
        },
        disconnect() {},
      };
    }
    createOscillator() {
      return { frequency: { ...param }, connect: () => this.createGain(), start() {}, stop() {} };
    }
    createBufferSource() {
      const source = {
        loop: false,
        started: false,
        stopped: false,
        connect() {},
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    }
  }
  const context = vm.createContext({
    AudioContext: Audio,
    performance: { now: () => now },
    queueMicrotask,
    DEFAULT_TUNE,
    length,
    repeats,
    TUNES,
    signal: (value: unknown) => ({ value }),
    remember() {},
    remembered: (key: string) => (key.startsWith('sound:') ? 'file' : ''),
    addEventListener() {},
    idbGet: async () => (fileExists ? { blob: { arrayBuffer: async () => new ArrayBuffer(1) } } : undefined),
    setTimeout: (run: () => void, ms: number) => {
      const id = ++next;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const source = readFileSync(new URL('./sounds.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')).replace(/\bexport\s+/g, '');
  vm.runInContext(
    code +
      '\nglobalThis.subject={playSound,messageSoundAllowed,messagesDuringCalls,setMessagesDuringCalls,choose,playing:()=>playing,cached:(kind)=>decoded.get(kind)};',
    context,
  );
  const subject = (
    context as unknown as {
      subject: {
        playSound: (kind: string, options?: { preview?: boolean; ended?: () => void }) => () => void;
        playing: () => number;
        messageSoundAllowed: (call: boolean, now?: number) => boolean;
        messagesDuringCalls: { value: boolean };
        setMessagesDuringCalls: (on: boolean) => void;
        choose: (kind: string, id: string) => void;
        cached: (kind: string) => { duration: number; length: number; getChannelData: (ch: number) => Float32Array };
      };
    }
  ).subject;
  return {
    ...subject,
    sources,
    suspended: () => suspended,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await flush();
      }
      now = end;
    },
  };
}

test('custom message, join and leave files play once, are bounded and release the audio context', async () => {
  for (const kind of ['message', 'join', 'leave']) {
    const a = audio(true);
    a.playSound(kind);
    await flush();
    assert.equal(a.sources[0].started, true);
    assert.equal(a.sources[0].loop, false);
    await a.advance(6200);
    assert.equal(a.sources[0].stopped, true);
    assert.equal(a.playing(), 0);
    assert.equal(a.suspended(), 1);
  }
});

test('one-shot sound cache retains only five seconds of decoded PCM', async () => {
  for (const kind of ['message', 'join', 'leave']) {
    const a = audio(true, false, 180);
    a.playSound(kind);
    await flush();
    const buffer = a.cached(kind);
    assert.equal(buffer.duration, 5);
    assert.equal(buffer.length, 500);
    assert.equal(buffer.getChannelData(0)[0], 0.25);
  }
});

test('short custom previews complete on natural end and do not repeat a ring', async () => {
  for (const kind of ['message', 'ring']) {
    const a = audio(true, false, 0.2);
    let ended = 0;
    const stop = a.playSound(kind, { preview: true, ended: () => ended++ });
    await flush();
    assert.equal(a.sources[0].loop, false);
    a.sources[0].onended?.();
    assert.equal(a.playing(), 0);
    assert.equal(ended, 1);
    stop();
    await a.advance(7000);
    assert.equal(ended, 1);
  }
});

test('message cooldown suppresses bursts and call sounds require a saved opt-in', () => {
  const a = audio(true);
  assert.equal(a.messagesDuringCalls.value, false);
  assert.equal(a.messageSoundAllowed(true, 0), false);
  assert.equal(a.messageSoundAllowed(false, 0), true);
  assert.equal(a.messageSoundAllowed(false, 1499), false);
  assert.equal(a.messageSoundAllowed(false, 1500), true);
  a.setMessagesDuringCalls(true);
  assert.equal(a.messageSoundAllowed(true, 3000), true);
  assert.equal(a.messageSoundAllowed(true, 3001), false);
  a.choose('message', 'off');
  assert.equal(a.messageSoundAllowed(true, 5000), false);
});
test('a missing custom one-shot file falls back without retaining an idle audio context', async () => {
  const a = audio(false);
  a.playSound('join');
  await flush();
  await a.advance(2500);
  assert.equal(a.playing(), 0);
  assert.equal(a.suspended(), 1);
});

test('unavailable audio cannot interrupt call or message handling', () => {
  const a = audio(true, true);
  assert.doesNotThrow(() => a.playSound('join')());
  assert.doesNotThrow(() => a.playSound('message')());
  assert.equal(a.playing(), 0);
});

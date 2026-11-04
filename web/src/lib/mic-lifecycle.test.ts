import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { GATE_OFF, readMicSettings } from './mic-settings.ts';

function subject(active = true, userAgent = 'Chrome/150 Linux') {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const contexts: { state: string }[] = [];
  const toasts: string[] = [];
  let downloaded!: (value: unknown) => void;
  let downloads = 0;
  const download = new Promise((resolve) => { downloaded = resolve; });
  const node = () => ({ connect: (other: unknown) => other, disconnect() {}, frequency: { setTargetAtTime() {} }, Q: { value: 0 } });
  const context = vm.createContext({
    AbortController, AbortSignal, WebAssembly: { compile: async () => ({}) },
    AudioWorkletNode: class {}, MediaStream: class {},
    AudioContext: class {
      state = 'running'; currentTime = 0;
      constructor() { contexts.push(this); }
      async resume() {}
      async close() { this.state = 'closed'; }
      createBiquadFilter = node;
      createMediaStreamSource = node;
      audioWorklet = { addModule: async () => {} };
    },
    signal: (value: unknown) => ({ value }), readMicSettings, GATE_OFF,
    navigator: { userAgent, userActivation: { hasBeenActive: active } },
    mobile: false, remembered: (key: string) => key === 'micSettings' ? '{"model":"browser"}' : '', remember() {},
    deepfilterWasm: 'model.wasm', gateWorklet: 'gate.js', t: String, showToast: (s: string) => toasts.push(s),
    fetch: () => { downloads++; return download; },
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const source = readFileSync(new URL('./mic.ts', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\} from [^;]+;\s*/gm, '')
    .replaceAll('import.meta.env.BASE_URL', "'/'");
  vm.runInContext(stripTypeScriptTypes(source).replace(/\bexport\s+/g, '') + '\nglobalThis.subject={openMic,setMicSettings,warmMic,micConstraints,wantsProcessing,micFailure,resumeMicContext};', context);
  const s = context.subject as {
    openMic: (raw: ReturnType<typeof raw>, signal?: AbortSignal, purpose?: 'call' | 'preview') => Promise<{ raw: unknown; track: unknown; sampleRate?: number; close(): void }>;
    warmMic: () => void; setMicSettings: (s: object) => boolean; micConstraints: () => { sampleRate?: number; noiseSuppression: boolean };
    wantsProcessing: () => boolean; micFailure: { value: boolean };
    resumeMicContext: (ctx: unknown, signal?: AbortSignal) => Promise<boolean>;
  };
  function raw(rate = 48000) {
    const constraints = { noiseSuppression: false };
    return { enabled: true, readyState: 'live', addEventListener() {}, removeEventListener() {}, getSettings: () => ({ sampleRate: rate }), getConstraints: () => constraints,
      applyConstraints: async (next: typeof constraints) => Object.assign(constraints, next), stop() { this.readyState = 'ended'; } };
  }
  return { s, raw, contexts, toasts, downloads: () => downloads, downloaded,
    timeout(ms: number) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } } };
}
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test('plain browser/off and custom browser capture choices do not create an audio context', async () => {
  for (const patch of [{ model: 'browser' }, { model: 'off' }, { model: 'browser', agc: false }, { model: 'browser', echo: false }]) {
    const h = subject(); h.s.setMicSettings(patch);
    const raw = h.raw(), mic = await h.s.openMic(raw);
    assert.equal(mic.track, raw); assert.equal(h.contexts.length, 0);
    assert.equal(mic.sampleRate, 48000);
    assert.equal(h.s.micConstraints().sampleRate, undefined);
    mic.close();
  }
});

test('crossing the audio graph boundary requires capture reopening, live tuning does not', () => {
  const h = subject();
  assert.equal(h.s.wantsProcessing(), false);
  assert.equal(h.s.setMicSettings({ gain: 1 }), true);
  assert.equal(h.s.setMicSettings({ gain: 2 }), false);
  assert.equal(h.s.setMicSettings({ gain: 0 }), true);
  assert.equal(h.s.setMicSettings({ highPass: true }), true);
  assert.equal(h.s.setMicSettings({ highPass: false }), true);
  assert.equal(h.s.setMicSettings({ gate: -40 }), true);
  assert.equal(h.s.setMicSettings({ gate: -35 }), false);
  assert.equal(h.s.setMicSettings({ gate: -70 }), true);
  assert.equal(h.s.setMicSettings({ agc: false }), true);
  assert.equal(h.s.wantsProcessing(), true);
});

test('a call without page activation uses browser suppression without an error or context', async () => {
  const h = subject(false); h.s.setMicSettings({ model: 'rnnoise' });
  const mic = await h.s.openMic(h.raw());
  assert.equal(mic.raw, mic.track); assert.equal(h.contexts.length, 0);
  assert.deepEqual(h.toasts, []); mic.close();
});

test('Firefox uses native suppression for a non-48 kHz capture without an incompatible context', async () => {
  const h = subject(true, 'Firefox/153.0'); h.s.setMicSettings({ model: 'rnnoise' });
  const raw = h.raw(44100), mic = await h.s.openMic(raw);
  assert.equal(mic.track, raw); assert.equal(h.contexts.length, 0);
  assert.equal(mic.sampleRate, 44100);
  assert.equal(raw.getConstraints().noiseSuppression, true);
  assert.deepEqual(h.toasts, []); mic.close();
});

test('the chosen model is fetched ahead of a call, once per choice', () => {
  const h = subject();
  h.s.warmMic();
  assert.equal(h.downloads(), 0, 'nothing to fetch for the browser model');
  h.s.setMicSettings({ model: 'rnnoise' });
  assert.equal(h.downloads(), 1);
  h.s.setMicSettings({ gain: 3 });
  assert.equal(h.downloads(), 1, 'a slider fetches nothing');
  h.s.warmMic();
  assert.equal(h.downloads(), 2, 'a new page warms the cache again');
});

test('a cold model is prefetched and setup deadline keeps raw alive for native fallback', async () => {
  const h = subject(); h.s.setMicSettings({ model: 'deepfilter' });
  assert.equal(h.downloads(), 1);
  const raw = h.raw(), pending = h.s.openMic(raw);
  await tick(); h.timeout(3000); await tick();
  const mic = await pending;
  assert.equal(mic.track, raw); assert.equal(raw.readyState, 'live');
  assert.equal(raw.getConstraints().noiseSuppression, true);
  assert.ok(h.contexts.every((c) => c.state === 'closed'));
  assert.equal(h.downloads(), 1); mic.close();
  h.s.setMicSettings({ model: 'browser' });
  const native = await h.s.openMic(h.raw());
  assert.equal(h.s.micFailure.value, false); native.close();
});

test('tuning after native fallback reopens the missing graph instead of silently ignoring gain', async () => {
  const h = subject(false); h.s.setMicSettings({ model: 'rnnoise' });
  const mic = await h.s.openMic(h.raw());
  assert.equal(h.s.setMicSettings({ gain: 6 }), true);
  mic.close();
  assert.equal(h.s.setMicSettings({ gain: 7 }), false);
});

test('explicit preview can initialize a model beyond the call budget but remains bounded', async () => {
  const h = subject(); h.s.setMicSettings({ model: 'deepfilter' });
  const raw = h.raw(), pending = h.s.openMic(raw, undefined, 'preview');
  await tick(); h.timeout(3000); await tick();
  assert.equal(h.contexts[0].state, 'running');
  h.timeout(15000);
  const mic = await pending;
  assert.equal(mic.track, raw); assert.ok(h.contexts.every((c) => c.state === 'closed'));
  mic.close();
});

test('cancelling pending setup stops raw and never enters deadline fallback', async () => {
  const h = subject(); h.s.setMicSettings({ model: 'deepfilter' });
  const raw = h.raw(), controller = new AbortController();
  const pending = h.s.openMic(raw, controller.signal);
  await tick(); controller.abort(); h.timeout(3000);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(raw.readyState, 'ended'); assert.deepEqual(h.toasts, []);
  assert.ok(h.contexts.every((c) => c.state === 'closed'));
});

test('a hung preview context resume is bounded and abortable', async () => {
  const h = subject();
  const context = { state: 'suspended', resume: () => new Promise(() => {}) };
  const waiting = h.s.resumeMicContext(context); await tick(); h.timeout(2000);
  assert.equal(await waiting, false);
  const controller = new AbortController();
  const cancelled = h.s.resumeMicContext(context, controller.signal); controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
});

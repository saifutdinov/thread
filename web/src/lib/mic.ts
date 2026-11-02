import { signal } from '@preact/signals';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import gateWorklet from './gate-worklet.js?url&no-inline'; // a data: URL would break the CSP
import { remember, remembered } from './devices';
import { t } from './i18n';
import { mobile } from './pwa';
import { showToast } from './store';

// The microphone of a call: the browser's own echo cancellation and gain,
// then, when chosen on this device, RNNoise instead of the browser's noise
// suppression and a voice gate. Computers only: phones' own processing
// does well, and on iPhones a Web Audio microphone hurts echo cancellation.
// Safari is left out too: its voice processing already suppresses noise.
const ua = navigator.userAgent;
const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
export const canTune = !mobile && !safari && typeof AudioWorkletNode !== 'undefined';

// Windows gets the weakest noise suppression from the browser: on by default there.
const windows = /Windows/.test(ua);
const saved = remembered('micDenoise');
export const micDenoise = signal(canTune && (saved ? saved === '1' : windows));

// The gate's threshold in dB; GATE_OFF and below lets everything through.
export const GATE_OFF = -70;
export const GATE_MAX = -10;
export const micGate = signal(Number(remembered('micGate')) || GATE_OFF);

// The level the gate hears, in dB, while a meter watches.
export const micLevel = signal(-100);

export function micConstraints(deviceId?: ConstrainDOMString): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: !micDenoise.value,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
    ...(deviceId ? { deviceId } : {}),
  };
}

// Mic: the captured microphone, what a call sends (the processed track, or
// the same raw one) and how to let go of both.
export type Mic = { raw: MediaStreamTrack; track: MediaStreamTrack; close(): void };

type Chain = { ctx: AudioContext; gate: AudioWorkletNode; out: MediaStreamTrack };
let current: Chain | null = null;
let watchers = 0;
let wasm: Promise<ArrayBuffer> | null = null;

const gateOn = () => micGate.value > GATE_OFF;
const threshold = () => (gateOn() ? micGate.value : -100);
export const wantsProcessing = () => canTune && (micDenoise.value || gateOn());

// openMic puts the processing on a freshly captured track. Processing that
// fails costs only the processing: the call sends the raw microphone.
export async function openMic(raw: MediaStreamTrack): Promise<Mic> {
  const plain = { raw, track: raw, close: () => raw.stop() };
  if (!wantsProcessing()) return plain;
  let chain: Chain;
  try {
    chain = await build(raw, micDenoise.value);
  } catch {
    showToast(t('mic.failed'));
    return micDenoise.value ? withSuppression(raw) : plain;
  }
  current = chain;
  if (watchers) chain.gate.port.postMessage(true);
  return {
    raw,
    track: chain.out,
    close() {
      if (current === chain) {
        current = null;
        micLevel.value = -100; // no chain, nothing to show
      }
      chain.out.stop();
      raw.stop();
      void chain.ctx.close();
    },
  };
}

// withSuppression opens the microphone again with the browser's noise
// suppression, which RNNoise was to replace.
async function withSuppression(raw: MediaStreamTrack): Promise<Mic> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { ...raw.getConstraints(), noiseSuppression: true } });
    const next = s.getAudioTracks()[0];
    next.enabled = raw.enabled;
    raw.stop();
    return { raw: next, track: next, close: () => next.stop() };
  } catch {
    return { raw, track: raw, close: () => raw.stop() };
  }
}

async function build(raw: MediaStreamTrack, denoise: boolean): Promise<Chain> {
  // RNNoise works at 48 kHz only; the browser resamples the microphone.
  const ctx = new AudioContext(denoise ? { sampleRate: 48000, latencyHint: 'interactive' } : { latencyHint: 'interactive' });
  try {
    // A context the page may not start would send silence: give up instead.
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 2000))]);
    if (ctx.state !== 'running') throw new Error('audio');
    let node: AudioNode = ctx.createMediaStreamSource(new MediaStream([raw]));
    if (denoise) {
      const { RnnoiseWorkletNode, loadRnnoise } = await import('@sapphi-red/web-noise-suppressor');
      wasm ??= loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm }).catch((e) => {
        wasm = null;
        throw e;
      });
      await ctx.audioWorklet.addModule(rnnoiseWorklet);
      const rn = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: await wasm });
      // Mono in and out: a second, silent channel would halve the voice in the mixdown.
      rn.channelCount = 1;
      rn.channelCountMode = 'explicit';
      node = node.connect(rn);
    }
    await ctx.audioWorklet.addModule(gateWorklet);
    const gate = new AudioWorkletNode(ctx, 'voice-gate', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    gate.parameters.get('threshold')?.setValueAtTime(threshold(), 0);
    gate.port.onmessage = (e) => (micLevel.value = e.data as number);
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    node.connect(gate).connect(dest);
    const out = dest.stream.getAudioTracks()[0];
    out.contentHint = 'speech';
    return { ctx, gate, out };
  } catch (e) {
    void ctx.close();
    throw e;
  }
}

// setDenoise switches RNNoise; the call reopens its microphone after it,
// since the browser's suppression is chosen when the microphone opens.
export function setDenoise(on: boolean) {
  micDenoise.value = on;
  remember('micDenoise', on ? '1' : '0');
}

// setGate moves the threshold. True when the call has to reopen its
// microphone to put a gate on it.
export function setGate(db: number): boolean {
  micGate.value = db;
  remember('micGate', String(db));
  if (current) {
    current.gate.parameters.get('threshold')?.setValueAtTime(threshold(), current.ctx.currentTime);
    return false;
  }
  return gateOn();
}

// watchLevel starts the meter; the returned function stops it.
export function watchLevel() {
  if (!watchers++) current?.gate.port.postMessage(true);
  return () => {
    if (--watchers) return;
    current?.gate.port.postMessage(false);
    micLevel.value = -100;
  };
}

// latest runs fn once at a time; calls while it runs make one more run
// after it, with the settings as they are by then.
export function latest(fn: () => Promise<void>) {
  let busy: Promise<void> | null = null;
  let again = false;
  return function run(): Promise<void> {
    if (busy) {
      again = true;
      return busy;
    }
    busy = (async () => {
      do {
        again = false;
        await fn();
      } while (again);
    })().finally(() => (busy = null));
    return busy;
  };
}

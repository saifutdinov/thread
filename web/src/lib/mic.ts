import { signal } from '@preact/signals';
import gateWorklet from './gate-worklet.js?url&no-inline';
import deepfilterWasm from '@lofcz/deepfilternet-web/df_bg.wasm?url&no-inline';
import { remember, remembered } from './devices';
import { t } from './i18n';
import { mobile } from './pwa';
import { showToast } from './store';
import { GATE_OFF, readMicSettings, type MicSettings } from './mic-settings';
export { GATE_OFF, GATE_MAX } from './mic-settings';
export { cancelMicRequest, type MicRequest } from './mic-request';

const ua = navigator.userAgent;
const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
export const canTune = !mobile && !safari && typeof AudioWorkletNode !== 'undefined';
export const micSettings = signal(readMicSettings(remembered('micSettings'), { denoise: remembered('micDenoise'), gate: remembered('micGate') }, canTune));
export const micLevel = signal(-100);
export const micFailure = signal(false);
export const pushToTalk = signal(remembered('pushToTalk') === '1');
export function setPushToTalk(on: boolean) {
  remember('pushToTalk', on ? '1' : '0');
  pushToTalk.value = on;
}

const model = () => canTune ? micSettings.value.model : 'browser';
const customModel = () => model() === 'rnnoise' || model() === 'deepfilter';
const hasActivation = () => navigator.userActivation?.hasBeenActive !== false;
const threshold = () => micSettings.value.gate <= GATE_OFF ? -100 : micSettings.value.gate;
const needsGraph = (s: MicSettings = micSettings.value) => canTune &&
  (s.model === 'rnnoise' || s.model === 'deepfilter' || s.gate > GATE_OFF || s.gain !== 0 || s.highPass);
// A custom group capture can be needed without an AudioContext: LiveKit's
// defaults otherwise lose an explicit off/AEC/AGC choice.
export const wantsProcessing = () => needsGraph() || (canTune &&
  (micSettings.value.model === 'off' || !micSettings.value.agc || !micSettings.value.echo));
export function micConstraints(deviceId?: ConstrainDOMString): MediaTrackConstraints {
  const s = micSettings.value;
  return { echoCancellation: canTune ? s.echo : true, noiseSuppression: model() === 'browser' || (!hasActivation() && needsGraph()), autoGainControl: canTune ? s.agc : true, channelCount: 1, ...(customModel() && hasActivation() ? { sampleRate: 48000 } : {}), ...(deviceId ? { deviceId } : {}) };
}
export type Mic = { raw: MediaStreamTrack; track: MediaStreamTrack; sampleRate?: number; close(): void };
type Chain = { ctx: AudioContext; gate: AudioWorkletNode; highPass: BiquadFilterNode; denoiser?: AudioWorkletNode; out: MediaStreamTrack };
const chains = new Set<Chain>();
const nativeMicrophones = new Set<MediaStreamTrack>();
function rawMic(raw: MediaStreamTrack): Mic {
  nativeMicrophones.add(raw);
  const ended = () => nativeMicrophones.delete(raw);
  raw.addEventListener('ended', ended, { once: true });
  let closed = false;
  return { raw, track: raw, sampleRate: raw.getSettings().sampleRate, close() {
    if (closed) return;
    closed = true;
    raw.removeEventListener('ended', ended);
    nativeMicrophones.delete(raw);
    raw.stop();
  } };
}
let watchers = 0;
let deepfilter: Promise<WebAssembly.Module> | undefined;
const audioUrl = (file: string) => `${import.meta.env.BASE_URL}audio/${file}`;

export function loadDeepfilter() {
  // Shared download/compile can finish after a call falls back or is cancelled.
  // It owns no microphone or AudioContext and is reused by the next attempt.
  return deepfilter ??= fetch(deepfilterWasm, { signal: AbortSignal.timeout(120000) }).then(async (response) => {
    if (!response.ok) throw new Error('model download');
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch((error) => {
    deepfilter = undefined;
    throw error;
  });
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Microphone setup cancelled'), { name: 'AbortError' });
}
function waitForSetup<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    promise.then((value) => {
      signal.removeEventListener('abort', cancel);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}

function configure(chain: Chain) {
  const s = micSettings.value;
  const now = chain.ctx.currentTime;
  chain.gate.parameters.get('threshold')?.setValueAtTime(threshold(), now);
  chain.gate.parameters.get('hold')?.setValueAtTime(s.hold / 1000, now);
  chain.gate.parameters.get('gainDb')?.setTargetAtTime(s.gain, now, 0.02);
  chain.highPass.frequency.setTargetAtTime(s.highPass ? 80 : 0, now, 0.02);
  chain.denoiser?.port.postMessage({ type: 'strength', value: s.strength });
}

export function setMicSettings(patch: Partial<MicSettings>): boolean {
  const previous = micSettings.value;
  const previousGraph = needsGraph();
  const previousCapture = wantsProcessing();
  const next = readMicSettings(JSON.stringify({ ...previous, ...patch }), { denoise: '', gate: '' }, canTune);
  micSettings.value = next;
  remember('micSettings', JSON.stringify(next));
  if (canTune && next.model === 'deepfilter') void loadDeepfilter().catch(() => {});
  for (const chain of chains) configure(chain);
  return previous.model !== next.model || previous.agc !== next.agc || previous.echo !== next.echo ||
    previousGraph !== needsGraph() || previousCapture !== wantsProcessing() ||
    (needsGraph() && nativeMicrophones.size > 0);
}

export async function resumeMicContext(ctx: AudioContext, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForSetup(Promise.race([ctx.resume(), new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]), signal);
    return ctx.state === 'running';
  } finally {
    clearTimeout(timer);
  }
}

export function watchLevel() {
  if (!watchers++) for (const chain of chains) chain.gate.port.postMessage(true);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--watchers) return;
    for (const chain of chains) chain.gate.port.postMessage(false);
    micLevel.value = -100;
  };
}

async function ready(node: AudioWorkletNode, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForSetup(new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('processor timeout')), 15000);
      node.onprocessorerror = () => reject(new Error('processor'));
      node.port.onmessage = ({ data }) => {
        if (data.type !== 'ready' && data.type !== 'error') return;
        if (data.type === 'ready') resolve();
        else reject(new Error('model'));
      };
    }), signal);
  } finally {
    clearTimeout(timer);
    node.onprocessorerror = null;
    node.port.onmessage = null;
  }
}

async function build(raw: MediaStreamTrack, signal?: AbortSignal): Promise<Chain> {
  const ctx = new AudioContext({ sampleRate: customModel() ? 48000 : raw.getSettings().sampleRate, latencyHint: 'interactive' });
  const live = () => {
    checkCancelled(signal);
    if (raw.readyState === 'ended') throw new Error('cancelled');
  };
  try {
    // A suspended context produces a valid-looking but silent outgoing track.
    // Never publish it or wait indefinitely for a missing user activation.
    const running = await resumeMicContext(ctx, signal);
    live();
    if (!running) throw new Error('audio');
    const highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.Q.value = 0.707;
    let node: AudioNode = ctx.createMediaStreamSource(new MediaStream([raw]));
    node.connect(highPass);
    node = highPass;
    let denoiser: AudioWorkletNode | undefined;
    if (customModel()) {
      const selected = model();
      const processorOptions: { strength: number; wasmModule?: WebAssembly.Module } = { strength: micSettings.value.strength };
      if (selected === 'deepfilter') {
        processorOptions.wasmModule = await waitForSetup(loadDeepfilter(), signal);
        live();
      }
      await waitForSetup(ctx.audioWorklet.addModule(audioUrl(`${selected}-worklet.js`)), signal);
      live();
      denoiser = new AudioWorkletNode(ctx, `thread-${selected}`, { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1], processorOptions });
      await ready(denoiser, signal);
      live();
      node = node.connect(denoiser);
    }
    await waitForSetup(ctx.audioWorklet.addModule(gateWorklet), signal);
    live();
    const gate = new AudioWorkletNode(ctx, 'voice-gate', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    node.connect(gate).connect(dest);
    const out = dest.stream.getAudioTracks()[0];
    out.contentHint = 'speech';
    out.enabled = raw.enabled;
    const chain = { ctx, gate, highPass, denoiser, out };
    configure(chain);
    gate.port.onmessage = ({ data }) => { micLevel.value = data as number; };
    if (denoiser) {
      const fail = () => {
        if (!chains.has(chain) || !chain.denoiser) return;
        // Preserve the published output, gate, gain and mute/PTT state. Only
        // the failed model is removed; no signaling or device reopening.
        highPass.disconnect(denoiser);
        denoiser.disconnect();
        denoiser.port.postMessage({ type: 'close' });
        chain.denoiser = undefined;
        highPass.connect(gate);
        micFailure.value = true;
        showToast(t('mic.runtimeFailed'));
      };
      denoiser.onprocessorerror = fail;
      denoiser.port.onmessage = ({ data }) => { if (data.type === 'error') fail(); };
    }
    return chain;
  } catch (error) {
    void ctx.close().catch(() => {});
    throw error;
  }
}

// Calls and the device check share this exact output track. No server inference.
async function prepareMic(raw: MediaStreamTrack, signal?: AbortSignal, setupMs = 3000): Promise<Mic> {
  checkCancelled(signal);
  if (!needsGraph()) {
    micFailure.value = false;
    return rawMic(raw);
  }
  // Firefox does not connect a MediaStream source across context rates. Native
  // suppression is the usable default for a non-48 kHz device, without an error.
  const captureRate = raw.getSettings().sampleRate;
  if (/Firefox\//.test(ua) && customModel() && captureRate && captureRate !== 48000) return nativeMic(raw, signal, false);
  // Notification/reload joins may have no activation. Keep them audible with
  // native suppression, without creating a context that cannot run or an error toast.
  if (!hasActivation()) return nativeMic(raw, signal, false);
  let chain: Chain;
  const setup = new AbortController();
  const cancel = () => setup.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  // Offer/answer must not wait for a 34 MB model. Timeout only preparation,
  // never the raw capture needed for fallback; the shared download continues.
  const timer = setTimeout(() => setup.abort(), setupMs);
  try {
    chain = await build(raw, setup.signal);
  } catch {
    checkCancelled(signal);
    if (raw.readyState === 'ended') return rawMic(raw);
    return nativeMic(raw, signal, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  if (signal?.aborted) {
    chain.out.stop();
    void chain.ctx.close().catch(() => {});
    checkCancelled(signal);
  }
  micFailure.value = false;
  chains.add(chain);
  if (watchers) chain.gate.port.postMessage(true);
  let closed = false;
  return { raw, track: chain.out, sampleRate: chain.ctx.sampleRate, close() {
    if (closed) return;
    closed = true;
    chains.delete(chain);
    chain.denoiser?.port.postMessage({ type: 'close' });
    chain.out.stop();
    raw.stop();
    void chain.ctx.close().catch(() => {});
    if (!chains.size) micLevel.value = -100;
  } };
}

async function nativeMic(raw: MediaStreamTrack, signal: AbortSignal | undefined, warn: boolean): Promise<Mic> {
  micFailure.value = warn;
  if (warn) showToast(t('mic.failed'));
  if (raw.getConstraints().noiseSuppression === true) return rawMic(raw);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const constraints = { ...raw.getConstraints(), noiseSuppression: true };
    delete constraints.sampleRate;
    // Reuse the owned capture: another getUserMedia can itself hang and would
    // defeat the startup deadline. Applying constraints must also be bounded.
    await waitForSetup(Promise.race([raw.applyConstraints(constraints), new Promise((resolve) => { timer = setTimeout(resolve, 500); })]), signal);
  } catch {
    checkCancelled(signal);
  } finally {
    clearTimeout(timer);
  }
  checkCancelled(signal);
  return rawMic(raw);
}

export async function openMic(raw: MediaStreamTrack, signal?: AbortSignal, purpose: 'call' | 'preview' = 'call'): Promise<Mic> {
  const cancel = () => raw.stop();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    // An explicit local model check can wait longer; offer/answer and live
    // replacements always keep the short call budget unless requested here.
    const result = await prepareMic(raw, signal, purpose === 'preview' ? 15000 : 3000);
    if (signal?.aborted) {
      result.close();
      checkCancelled(signal);
    }
    return result;
  }
  catch (error) {
    if (signal?.aborted) raw.stop();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

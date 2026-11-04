// Sounds the app plays itself: the incoming call, the line while calling,
// a new message while the app is open, joining and leaving a call. Each kind plays
// a built-in tune (tunes.ts) or a sound file of the person's own; the
// choice is kept on this device only (localStorage, the file in IndexedDB).
// A closed app's notifications sound as the system decides.
import { signal } from '@preact/signals';
import { remember, remembered } from './devices';
import { idbGet, idbSet } from './idb';
import { DEFAULT_TUNE, length, repeats, type Note, type SoundKind, type Tune, TUNES } from './tunes';

export type { SoundKind };

export const MAX_SOUND_FILE = 3 << 20;

interface OwnSound {
  name: string;
  blob: Blob;
}

const key = (kind: SoundKind) => 'sound:' + kind;

function chosen(kind: SoundKind): string {
  const v = remembered(key(kind));
  return v === 'file' || Object.hasOwn(TUNES[kind], v) ? v : DEFAULT_TUNE[kind];
}

// The choice per kind: a tune id from tunes.ts, or 'file'.
export const choices = signal<Record<SoundKind, string>>({
  ring: chosen('ring'), dial: chosen('dial'), message: chosen('message'), join: chosen('join'), leave: chosen('leave'),
});

export const messagesDuringCalls = signal(remembered('messagesDuringCalls') === '1');
export function setMessagesDuringCalls(enabled: boolean) {
  messagesDuringCalls.value = enabled;
  remember('messagesDuringCalls', enabled ? '1' : '0');
}
let lastMessageAt: number | null = null;
export function messageSoundAllowed(inCall: boolean, now = performance.now()) {
  if (choices.value.message === 'off' || (inCall && !messagesDuringCalls.value)) return false;
  if (lastMessageAt !== null && now - lastMessageAt < 1500) return false;
  lastMessageAt = now;
  return true;
}

export function choose(kind: SoundKind, id: string) {
  remember(key(kind), id);
  choices.value = { ...choices.value, [kind]: id };
}

// ownSoundName: the own file's name, if one is kept. One gone (the device
// was signed out, which clears IndexedDB) puts the default tune back.
export async function ownSoundName(kind: SoundKind): Promise<string | null> {
  const name = (await idbGet<OwnSound>(key(kind)).catch(() => undefined))?.name ?? null;
  if (!name && choices.value[kind] === 'file') choose(kind, DEFAULT_TUNE[kind]);
  return name;
}

// setOwnSound keeps a sound file for this kind and picks it. One that the
// browser cannot decode is refused here, not at the next call.
export async function setOwnSound(kind: SoundKind, file: File) {
  if (file.size > MAX_SOUND_FILE) throw new Error('too_large');
  const decoder = new OfflineAudioContext(1, 1, 44100);
  const buffer = await decoder.decodeAudioData(await file.arrayBuffer());
  await idbSet(key(kind), { name: file.name, blob: file } satisfies OwnSound);
  decoded.set(kind, retainedBuffer(decoder, kind, buffer));
  choose(kind, 'file');
}

// One AudioContext for every sound. iOS keeps a context silent until a tap
// has started it: each tap starts it, so a ring or a message later sounds
// although no tap made it. It sleeps a second after the last sound (an
// idle running context costs battery and may hold the audio session).
let shared: AudioContext | null = null;
let playing = 0;
let unlocked = false; // a tap has started it once: it can sound from now on
let sleep: ReturnType<typeof setTimeout> | undefined;
const audio = () => (shared ??= new AudioContext());
const idle = () => {
  clearTimeout(sleep);
  sleep = setTimeout(() => !playing && void shared?.suspend().catch(() => {}), 1000);
};
// wake starts the context; without a tap iOS may hold resume() until the
// next one, so it waits no longer than a moment (a message sound is not
// worth playing late).
const wake = () => {
  clearTimeout(sleep);
  let ac: AudioContext;
  try { ac = audio(); } catch { return Promise.resolve(); }
  const started = ac
    .resume()
    .then(() => void (unlocked ||= ac.state === 'running'))
    .catch(() => {});
  return Promise.race([started, new Promise((ok) => setTimeout(ok, 300))]);
};
for (const type of ['pointerdown', 'keydown'])
  addEventListener(type, () => void wake().then(() => !playing && idle()), { capture: true, passive: true });

// audible: a sound started now would be heard (the page may not sound on
// its own before the first tap); notify.ts lets the system sound otherwise.
export const audible = () => unlocked;

// play repeats a tune every `every` seconds (once when 0) until stopped.
// Each note fades in and out, so nothing clicks.
interface Playback { preview?: boolean; ended?: () => void }

function play(t: Tune, ended?: () => void): () => void {
  const ac = audio();
  const out = ac.createGain();
  out.connect(ac.destination);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  playing++;
  const voice = (n: Note, at: number, f: number, len: number, level: number) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = n.wave ?? 'sine';
    o.frequency.setValueAtTime(f, at);
    if (n.to) o.frequency.exponentialRampToValueAtTime((n.to * f) / n.f, at + len);
    const fade = Math.min(0.05, len / 3);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + Math.min(0.01, len / 4));
    if (n.bell) g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    else {
      g.gain.setValueAtTime(level, at + len - fade);
      g.gain.linearRampToValueAtTime(0, at + len);
    }
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + len + 0.05);
  };
  // A round is scheduled only while the context runs: on a stopped clock
  // the rounds would pile up and all sound at once when it starts.
  const once = () => {
    if (stopped) return;
    if (ac.state === 'running') {
      const t0 = ac.currentTime + 0.05;
      for (const n of t.notes) {
        voice(n, t0 + n.at, n.f, n.len, t.gain);
        if (n.bell) voice(n, t0 + n.at, n.f * 4, n.len / 4, t.gain / 8);
      }
    }
    if (t.every) timer = setTimeout(once, t.every * 1000);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    out.disconnect();
    playing--;
    idle();
    ended?.();
  };
  void wake().then(once).catch(stop);
  if (!t.every) setTimeout(stop, (length(t) + 0.3) * 1000);
  return stop;
}

// playOwn plays this kind's own file, looped for a ring or the line. A file
// gone missing, or one this browser cannot play, falls back to the default.
// The decoded own files, so a message or a ring does not read and decode
// a file of up to 3 MB every time.
const decoded = new Map<SoundKind, AudioBuffer>();

function retainedBuffer(ac: BaseAudioContext, kind: SoundKind, buffer: AudioBuffer) {
  if (repeats(kind) || buffer.duration <= 5) return buffer;
  const frames = Math.min(buffer.length, Math.ceil(5 * buffer.sampleRate));
  const short = ac.createBuffer(buffer.numberOfChannels, frames, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) short.copyToChannel(buffer.getChannelData(channel).subarray(0, frames), channel);
  return short;
}

function playOwn(kind: SoundKind, options: Playback): () => void {
  const ac = audio();
  const out = ac.createGain();
  out.gain.value = 0.8;
  out.connect(ac.destination);
  let stopped = false;
  let fallback: (() => void) | null = null;
  let src: AudioBufferSourceNode | null = null;
  const loop = repeats(kind) && !options.preview;
  playing++;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    fallback?.();
    try {
      src?.stop();
    } catch {
      /* not started yet */
    }
    out.disconnect();
    playing--;
    idle();
    options.ended?.();
  };
  void (async () => {
    try {
      let buf = decoded.get(kind);
      if (!buf) {
        const own = await idbGet<OwnSound>(key(kind));
        if (!own) throw new Error('no file');
        const loaded = await ac.decodeAudioData(await own.blob.arrayBuffer());
        buf = decoded.get(kind) ?? retainedBuffer(ac, kind, loaded);
        if (stopped) return;
        decoded.set(kind, buf);
      }
      await wake();
      // Not heard now (no tap yet): a message is skipped, not saved up.
      if (stopped || (ac.state !== 'running' && !loop)) return stop();
      src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.onended = stop;
      src.connect(out);
      src.start();
      if (!loop) setTimeout(stop, Math.min(buf.duration, options.preview ? 6 : 5) * 1000 + 100);
    } catch {
      if (!stopped) {
        fallback = playTune(kind, DEFAULT_TUNE[kind], { preview: options.preview });
        if (!loop) setTimeout(stop, (length(TUNES[kind][DEFAULT_TUNE[kind]]!) + 0.3) * 1000);
      }
    }
  })().catch(stop);
  return stop;
}

function playTune(kind: SoundKind, id: string, options: Playback = {}): () => void {
  const tune = Object.hasOwn(TUNES[kind], id) ? TUNES[kind][id] : TUNES[kind][DEFAULT_TUNE[kind]];
  if (tune) return play(options.preview ? { ...tune, every: 0 } : tune, options.ended);
  if (options.ended) queueMicrotask(options.ended);
  return () => {};
}

// playSound starts this kind's chosen sound: a ring and the line repeat
// until stopped, a message plays once. The returned function stops it.
export function playSound(kind: SoundKind, options: Playback = {}): () => void {
  try {
    const id = choices.value[kind];
    return id === 'file' ? playOwn(kind, options) : playTune(kind, id, options);
  } catch {
    if (options.ended) queueMicrotask(options.ended);
    return () => {}; // audio failure must not fail a message or a call
  }
}

export const hangupTone = () => playSound('leave');

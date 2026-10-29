// Sounds the app plays itself: the incoming call, the line while calling,
// a new message while the app is open, the end of a call. Each kind plays
// a built-in tune (tunes.ts) or a sound file of the person's own; the
// choice is kept on this device only (localStorage, the file in IndexedDB).
// A closed app's notifications sound as the system decides.
import { signal } from '@preact/signals';
import { remember, remembered } from './devices';
import { idbGet, idbSet } from './idb';
import { DEFAULT_TUNE, END_TUNE, length, type Note, type SoundKind, type Tune, TUNES } from './tunes';

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
export const choices = signal<Record<SoundKind, string>>({ ring: chosen('ring'), dial: chosen('dial'), message: chosen('message') });

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
  await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
  await idbSet(key(kind), { name: file.name, blob: file } satisfies OwnSound);
  decoded.delete(kind);
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
  const ac = audio();
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
function play(t: Tune): () => void {
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
  void wake().then(once);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    out.disconnect();
    playing--;
    idle();
  };
  if (!t.every) setTimeout(stop, (length(t) + 0.3) * 1000);
  return stop;
}

// playOwn plays this kind's own file, looped for a ring or the line. A file
// gone missing, or one this browser cannot play, falls back to the default.
// The decoded own files, so a message or a ring does not read and decode
// a file of up to 3 MB every time.
const decoded = new Map<SoundKind, AudioBuffer>();

function playOwn(kind: SoundKind): () => void {
  const ac = audio();
  const out = ac.createGain();
  out.gain.value = 0.8;
  out.connect(ac.destination);
  let stopped = false;
  let fallback: (() => void) | null = null;
  let src: AudioBufferSourceNode | null = null;
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
  };
  void (async () => {
    try {
      let buf = decoded.get(kind);
      if (!buf) {
        const own = await idbGet<OwnSound>(key(kind));
        if (!own) throw new Error('no file');
        buf = await ac.decodeAudioData(await own.blob.arrayBuffer());
        decoded.set(kind, buf);
      }
      await wake();
      // Not heard now (no tap yet): a message is skipped, not saved up.
      if (stopped || (ac.state !== 'running' && kind === 'message')) return stop();
      src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = kind !== 'message';
      src.connect(out);
      src.start();
      if (kind === 'message') setTimeout(stop, Math.min(buf.duration, 5) * 1000 + 100); // a long file is cut short
    } catch {
      if (!stopped) fallback = playTune(kind, DEFAULT_TUNE[kind]);
    }
  })();
  return stop;
}

function playTune(kind: SoundKind, id: string): () => void {
  const tune = Object.hasOwn(TUNES[kind], id) ? TUNES[kind][id] : TUNES[kind][DEFAULT_TUNE[kind]];
  return tune ? play(tune) : () => {};
}

// playSound starts this kind's chosen sound: a ring and the line repeat
// until stopped, a message plays once. The returned function stops it.
export function playSound(kind: SoundKind): () => void {
  const id = choices.value[kind];
  return id === 'file' ? playOwn(kind) : playTune(kind, id);
}

export const hangupTone = () => play(END_TUNE);

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
  return v === 'file' || v in TUNES[kind] ? v : DEFAULT_TUNE[kind];
}

// The choice per kind: a tune id from tunes.ts, or 'file'.
export const choices = signal<Record<SoundKind, string>>({ ring: chosen('ring'), dial: chosen('dial'), message: chosen('message') });

export function choose(kind: SoundKind, id: string) {
  remember(key(kind), id);
  choices.value = { ...choices.value, [kind]: id };
}

export const ownSoundName = async (kind: SoundKind) => (await idbGet<OwnSound>(key(kind)).catch(() => undefined))?.name ?? null;

// setOwnSound keeps a sound file for this kind and picks it. One that the
// browser cannot decode is refused here, not at the next call.
export async function setOwnSound(kind: SoundKind, file: File) {
  if (file.size > MAX_SOUND_FILE) throw new Error('too_large');
  await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
  await idbSet(key(kind), { name: file.name, blob: file } satisfies OwnSound);
  choose(kind, 'file');
}

// One AudioContext for every sound, resumed on each tap: iOS keeps a
// context silent until a tap has started it, and suspends it again in the
// background. A ring or a message then sounds although no tap made it.
let shared: AudioContext | null = null;
const audio = () => (shared ??= new AudioContext());
for (const type of ['pointerdown', 'keydown'])
  addEventListener(type, () => void audio().resume().catch(() => {}), { capture: true, passive: true });

// play repeats a tune every `every` seconds (once when 0) until stopped.
// Each note fades in and out, so nothing clicks.
function play(t: Tune): () => void {
  const ac = audio();
  ac.resume().catch(() => {});
  const out = ac.createGain();
  out.connect(ac.destination);
  let timer: ReturnType<typeof setTimeout> | undefined;
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
  const once = () => {
    const t0 = ac.currentTime + 0.05;
    for (const n of t.notes) {
      voice(n, t0 + n.at, n.f, n.len, t.gain);
      if (n.bell) voice(n, t0 + n.at, n.f * 4, n.len / 4, t.gain / 8);
    }
    if (t.every) timer = setTimeout(once, t.every * 1000);
  };
  once();
  const stop = () => {
    clearTimeout(timer);
    out.disconnect();
  };
  if (!t.every) setTimeout(stop, (length(t) + 0.3) * 1000);
  return stop;
}

// playOwn plays this kind's own file, looped for a ring or the line. A file
// gone missing, or one this browser cannot play, falls back to the default.
function playOwn(kind: SoundKind): () => void {
  const ac = audio();
  ac.resume().catch(() => {});
  const out = ac.createGain();
  out.gain.value = 0.8;
  out.connect(ac.destination);
  let stopped = false;
  let fallback: (() => void) | null = null;
  let src: AudioBufferSourceNode | null = null;
  const stop = () => {
    stopped = true;
    fallback?.();
    try {
      src?.stop();
    } catch {
      /* not started yet */
    }
    out.disconnect();
  };
  void (async () => {
    try {
      const own = await idbGet<OwnSound>(key(kind));
      if (!own) throw new Error('no file');
      const buf = await ac.decodeAudioData(await own.blob.arrayBuffer());
      if (stopped) return;
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
  const tune = id in TUNES[kind] ? TUNES[kind][id] : TUNES[kind][DEFAULT_TUNE[kind]];
  return tune ? play(tune) : () => {};
}

// playSound starts this kind's chosen sound: a ring and the line repeat
// until stopped, a message plays once. The returned function stops it.
export function playSound(kind: SoundKind): () => void {
  const id = choices.value[kind];
  return id === 'file' ? playOwn(kind) : playTune(kind, id);
}

export const hangupTone = () => play(END_TUNE);

// The built-in sounds, synthesized on the fly (sounds.ts plays them): no
// audio files to ship. A note is a pitch (Hz), a start and a length (s);
// `to` glides the pitch, `bell` rings out with a soft overtone like a
// marimba, otherwise it holds steady like a phone line. `every` repeats
// the tune (s), 0 plays it once. Kept pure for tests.

export type SoundKind = 'ring' | 'dial' | 'message';

export interface Note {
  f: number;
  at: number;
  len: number;
  to?: number;
  bell?: boolean;
  wave?: OscillatorType;
}

export interface Tune {
  notes: Note[];
  every: number;
  gain: number;
}

const C5 = 523.25, E5 = 659.25, F5 = 698.46, G5 = 783.99, GS5 = 830.61, A5 = 880, B5 = 987.77, C6 = 1046.5, E6 = 1318.51;

const bells = (fs: number[], step: number, len: number): Note[] => fs.map((f, i) => ({ f, at: i * step, len, bell: true }));

// A bell trill: two pitches in turn, like an old phone's hammer.
const trill = (from: number, secs: number): Note[] =>
  Array.from({ length: Math.round(secs / 0.05) }, (_, i) => ({ f: i % 2 ? 988 : 880, at: from + i * 0.05, len: 0.045, wave: 'triangle' as const }));

// null: silent (an incoming call still vibrates where the phone can).
export const TUNES: Record<SoundKind, Record<string, Tune | null>> = {
  ring: {
    // A rising E major arpeggio, answered by a short phrase.
    marimba: { notes: [...bells([E5, GS5, B5, E6], 0.15, 0.7), { f: B5, at: 1.2, len: 0.6, bell: true }, { f: E6, at: 1.35, len: 1.2, bell: true }], every: 3.2, gain: 0.07 },
    classic: { notes: [...trill(0, 1), ...trill(1.4, 1)], every: 4, gain: 0.05 },
    chimes: { notes: bells([C6, A5, F5, C5], 0.35, 1.2), every: 3.2, gain: 0.08 },
    digital: {
      notes: [0, 0.18, 0.6, 0.78].map((at) => ({ f: 1400, at, len: 0.12, wave: 'square' as const })),
      every: 2,
      gain: 0.025,
    },
    harp: { notes: bells([C5, E5, G5, C6, G5, E5, C5], 0.18, 0.9), every: 3.5, gain: 0.08 },
    off: null,
  },
  dial: {
    // The 425 Hz line tone of Russia and most of Europe, 0.8 s every 4 s.
    line: { notes: [{ f: 425, at: 0, len: 0.8 }], every: 4, gain: 0.05 },
    // North America: 440 and 480 Hz together, 2 s on, 4 s off.
    us: { notes: [{ f: 440, at: 0, len: 2 }, { f: 480, at: 0, len: 2 }], every: 6, gain: 0.03 },
    soft: { notes: bells([E5, C5], 0.4, 1), every: 3, gain: 0.05 },
    off: null,
  },
  message: {
    drop: { notes: [{ f: 1200, to: 600, at: 0, len: 0.14 }], every: 0, gain: 0.12 },
    pop: { notes: [{ f: 600, to: 300, at: 0, len: 0.09, wave: 'triangle' }], every: 0, gain: 0.15 },
    bell: { notes: bells([E6], 0, 0.7), every: 0, gain: 0.08 },
    chirp: { notes: [{ f: C6, to: E6, at: 0, len: 0.08 }, { f: E6, to: 1568, at: 0.11, len: 0.09 }], every: 0, gain: 0.08 },
    off: null,
  },
};

export const DEFAULT_TUNE: Record<SoundKind, string> = { ring: 'marimba', dial: 'line', message: 'drop' };

// The call is over: two falling notes (not a choice).
export const END_TUNE: Tune = { notes: [{ f: G5, at: 0, len: 0.4, bell: true }, { f: C5, at: 0.16, len: 0.7, bell: true }], every: 0, gain: 0.07 };

// length: when the last note of one round has died away.
export const length = (t: Tune) => Math.max(...t.notes.map((n) => n.at + n.len));

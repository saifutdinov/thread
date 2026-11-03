// Music tracks are files with audio inside (store.ts Attachment, t: 'file'),
// shown with the app's player (player.ts) instead of a file chip.

export type TrackLike = { t?: string; m: string; n?: string; ti?: string; ar?: string };

const EXT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};
const ext = (n = '') => /\.([a-z0-9]+)$/i.exec(n)?.[1].toLowerCase() ?? '';
const extType = (n?: string) => (Object.hasOwn(EXT_TYPES, ext(n)) ? EXT_TYPES[ext(n)] : undefined);
const AUDIO = /^audio\/[a-z0-9.+-]+$/;

export const isTrack = (a: TrackLike) => a.t === 'file' && (AUDIO.test(a.m.split(';')[0]) || !!extType(a.n));

// trackMime: the type a track plays as. Only audio types: what the sender
// wrote is not trusted to render anything else.
export function trackMime(a: TrackLike) {
  const m = a.m.split(';')[0].trim();
  return AUDIO.test(m) ? m : (extType(a.n) ?? 'audio/mpeg');
}

// trackInfo: title and artist from the tags (music by link), otherwise
// from the file name, "Artist - Title" split in two.
export function trackInfo(a: TrackLike): { title: string; artist: string } {
  if (a.ti) return { title: a.ti, artist: a.ar ?? '' };
  const name = (a.n ?? '').replace(/\.[^.]+$/, '');
  const i = name.indexOf(' - ');
  return i > 0 ? { title: name.slice(i + 3), artist: name.slice(0, i) } : { title: name, artist: '' };
}

// isSpotifyTrack: what the server takes for music by link (music.go).
export const isSpotifyTrack = (link: string) =>
  /^(?:https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?\/)?track\/|spotify:track:)[0-9A-Za-z]{22}(?:[/?#].*)?$/.test(link.trim());

// audioDuration reads a file's length in ms, 0 when the browser cannot.
export function audioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const el = new Audio();
    const url = URL.createObjectURL(file);
    const done = (ms: number) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      resolve(ms);
    };
    const timer = setTimeout(() => done(0), 5000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0);
    el.onerror = () => done(0);
    el.src = url;
  });
}

import { signal } from '@preact/signals';
import { errText } from './i18n';
import type { MediaLease } from './media-cache';
import { type Attachment, acquireMedia, messages, showToast } from './store';
import { isTrack, trackInfo } from './track';

// The music player: one <audio> for the whole app, so a track plays on
// while I move between chats; next and previous walk the tracks of the
// chat it came from. One sound at a time (claim): a voice message pauses
// the music, and the music pauses a voice message.

export type Track = { a: Attachment; chat: number };
export const player = signal<{ t: Track; playing: boolean } | null>(null);
export const playerPos = signal(0); // seconds
export const playerDur = signal(0);

let active: HTMLMediaElement | null = null;
export function claim(el: HTMLMediaElement) {
  if (active && active !== el) active.pause();
  active = el;
}

let el: HTMLAudioElement | null = null;
let lease: MediaLease | null = null; // the loaded track's URL: the media cache may not revoke it
function audio() {
  if (el) return el;
  const e = (el = new Audio());
  e.preload = 'auto';
  const playing = (v: boolean) => player.value && (player.value = { ...player.value, playing: v });
  e.onplay = () => playing(true);
  e.onpause = () => playing(false);
  e.ontimeupdate = () => (playerPos.value = e.currentTime);
  e.onloadedmetadata = () => Number.isFinite(e.duration) && (playerDur.value = e.duration);
  e.onended = () => void step(1);
  return e;
}

// The chat's tracks, in the order of its messages.
const tracksOf = (chat: number): Track[] =>
  (messages.value.get(chat) ?? []).flatMap((m) => (m.p?.a ?? []).filter(isTrack).map((a) => ({ a, chat })));

export async function playTrack(tr: Track) {
  if (player.value?.t.a.id === tr.a.id) return togglePlay();
  void graph?.ctx.resume(); // once in the graph, the element sounds only while it runs
  const e = audio();
  e.pause();
  player.value = { t: tr, playing: false };
  playerPos.value = 0;
  playerDur.value = (tr.a.d ?? 0) / 1000;
  const next = acquireMedia(tr.a);
  let url: string;
  try {
    url = await next.url;
  } catch (err) {
    next.release();
    if (player.value?.t === tr) player.value = null;
    return showToast(errText(err));
  }
  if (player.value?.t !== tr) return next.release(); // another track was picked meanwhile
  lease?.release();
  lease = next;
  e.src = url;
  claim(e);
  await e.play().catch(() => {});
  session(tr);
}

export function togglePlay() {
  const e = el;
  if (!e || !player.value) return;
  if (e.paused) {
    void graph?.ctx.resume();
    claim(e);
    void e.play().catch(() => {});
  } else e.pause();
}

export function seekTo(sec: number) {
  if (el) el.currentTime = Math.max(0, Math.min(sec, playerDur.value || sec));
}

// step goes to the chat's next (1) or previous (-1) track; "previous"
// first goes back to the start of this one, like any player.
export async function step(dir: 1 | -1) {
  const now = player.value;
  if (!now) return;
  if (dir < 0 && (el?.currentTime ?? 0) > 3) return seekTo(0);
  const list = tracksOf(now.t.chat);
  const i = list.findIndex((x) => x.a.id === now.t.a.id);
  const next = i < 0 ? undefined : list[i + dir];
  if (next) await playTrack(next);
  else if (dir > 0) playerPos.value = 0; // the last one ended
}

export function stopPlayer() {
  el?.pause();
  el?.removeAttribute('src');
  lease?.release();
  lease = null;
  player.value = null;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
}

// The lock screen and headphone buttons drive the player.
function session(tr: Track) {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const { title, artist } = trackInfo(tr.a);
  ms.metadata = new MediaMetadata({ title, artist });
  const on = (a: MediaSessionAction, h: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(a, h);
    } catch {
      // an action this browser does not know
    }
  };
  on('play', () => el?.paused && togglePlay());
  on('pause', () => el?.pause());
  on('nexttrack', () => void step(1));
  on('previoustrack', () => void step(-1));
  on('seekto', (d) => d.seekTime !== undefined && seekTo(d.seekTime));
}

// Music into a call: the player's sound goes through a WebAudio graph, to
// my speakers and to a track the call sends (call.ts shareMusic in 1:1,
// group.ts shareGroupMusic). From the first time on the element plays
// through that graph only, which is why the graph stays.
let graph: { ctx: AudioContext; out: MediaStreamAudioDestinationNode } | null = null;
export function musicTrack(): MediaStreamTrack {
  if (!graph) {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(audio());
    const out = ctx.createMediaStreamDestination();
    src.connect(ctx.destination);
    src.connect(out);
    graph = { ctx, out };
  }
  void graph.ctx.resume();
  return graph.out.stream.getAudioTracks()[0].clone();
}

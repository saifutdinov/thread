import { TalkButton, talkMode, talkHold, usePushToTalk } from './PushToTalk';
import { signal } from '@preact/signals';
import { type ComponentChildren, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  accept,
  call,
  type CallView,
  canShareScreen,
  decline,
  hangup,
  type Quality,
  reopenMic,
  selectCamera,
  selectMic,
  selectSpeaker,
  setBackground,
  setEffect,
  shareScreen,
  speaker,
  stopScreen,
  switchCamera,
  toggleCamera,
  toggleMute,
  setMuted,
  exportCallDiagnostics,
  selectNetworkMode,
  stopOwnVideo,
} from '../lib/call';
import { menuKey, voiceForCall, voiceVolume } from '../lib/call-menu';
import { cameras, canPickOutput, canSetVolume, remember, remembered } from '../lib/devices';
import { StreamVolume } from './StreamVolume';
import { BACKGROUNDS, EFFECTS } from '../lib/effects';
import { canFullscreen, fullscreen, setFullscreen } from '../lib/fullscreen';
import { t } from '../lib/i18n';
import { fmtDuration } from '../lib/recorder';
import { locked } from '../lib/lock';
import { callFit } from '../lib/prefs';
import { go } from '../lib/route';
import { isDoubleTap, placeTile, type Tap, tileWidth } from '../lib/tap';
import { type CallLog, chatPicture, findChat, showToast } from '../lib/store';
import { CallMenu } from './CallMenu';
import { CallSettings } from './CallSettings';
import { Avatar, Icon, IconButton, type IconName } from './ui';

// A minimized call shrinks to a strip at the top (and, with video, a small
// tile) so the app stays usable; the sound keeps playing.
export const minimized = signal(false);

// The other side's music plays at its own volume, remembered per device;
// a bit under the voice at first, so talk stays on top. iPhones and iPads
// ignore a page's volume (the buttons on the side set it): no slider there.
const savedMusicVolume = Number(remembered('musicVolume') || 0.7);
const musicVolume = signal(Number.isFinite(savedMusicVolume) ? Math.max(0, Math.min(1, savedMusicVolume)) : 0.7);
function setMusicVolume(value: number) {
  if (!Number.isFinite(value)) return;
  musicVolume.value = Math.max(0, Math.min(1, value));
  remember('musicVolume', String(musicVolume.value));
}

function Volumes(props: { name: string; music?: boolean }) {
  if (!canSetVolume) return null;
  return (
    <>
      <label class="participant-volume">
        <span>{t('call.volumeOf', { name: props.name })}</span>
        <input type="range" min="0" max="1" step="0.05" value={voiceVolume.value} onInput={(e) => (voiceVolume.value = Number(e.currentTarget.value))} />
      </label>
      {props.music && (
        <StreamVolume label={t('call.streamVolume')} value={musicVolume.value} onChange={setMusicVolume} />
      )}
    </>
  );
}

// attach sets a stream on a media element whenever the element appears:
// the self view is a new element each time the camera comes back on.
const attach = (s?: MediaStream) => (el: HTMLMediaElement | null) => {
  if (el && el.srcObject !== (s ?? null)) el.srcObject = s ?? null;
};

// Our own picture can be dragged anywhere in .call-room: between the buttons
// on top and the controls below, clear of a notch. Where it was left is kept
// as fractions of that room (placeTile), so it holds when the window or the
// picture changes size.
const selfPos = signal(((): [number, number] => {
  const [x, y] = remembered('selfTile').split(',').map(Number);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : [1, 0]; // top right at first
})());

// FxRow: one row of the effects tray, "none" first; scrolls sideways
// when it does not fit.
function FxRow<T extends string>(props: {
  label: string;
  none: string;
  items: { id: T; icon: string }[];
  on?: T;
  names: string;
  busy?: boolean;
  pick: (id: T | null) => unknown;
}) {
  const one = (id: T | null, label: string, icon: ComponentChildren) => (
    <button
      key={id ?? ''}
      type="button"
      class="fx"
      aria-pressed={(props.on ?? null) === id}
      title={label}
      aria-label={label}
      disabled={props.busy}
      onClick={() => void props.pick(id)}
    >
      {icon}
    </button>
  );
  return (
    <div class="fx-row" role="group" aria-label={props.label}>
      {one(null, props.none, <Icon name="close" size={22} />)}
      {props.items.map((e) => one(e.id, t(`${props.names}.${e.id}`), <span aria-hidden="true">{e.icon}</span>))}
    </div>
  );
}

function Btn(props: { icon: IconName; label: string; onClick: () => void; tone?: 'red' | 'green' | 'on'; expanded?: boolean }) {
  return (
    <button
      type="button"
      class={'call-btn ' + (props.tone ?? '')}
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      aria-expanded={props.expanded}
    >
      <Icon name={props.icon} size={28} />
      <small>{props.label}</small>
    </button>
  );
}

// BatteryNote: how charged the other side's phone or laptop is; a low,
// uncharged battery stands out, in words as well as in colour.
function BatteryNote(props: { b: { level: number; charging: boolean } }) {
  const { level: n, charging } = props.b;
  const low = !charging && n <= 20;
  return (
    <p class={'call-note' + (low ? ' warn' : '')}>
      <Icon name={charging ? 'bolt' : 'battery'} size={16} />{' '}
      {charging ? t('call.batteryCharging', { n }) : low ? t('call.batteryLow', { n }) : t('call.battery', { n })}
    </p>
  );
}

// QualityBadge: the connection level, with the numbers behind it on tap.
// Text, not just a colour, carries the level.
function QualityBadge(props: { q: Quality }) {
  const { q } = props;
  const [open, setOpen] = useState(false);
  const facts = [
    q.relay ? t('call.relay') : t('call.direct'),
    q.res,
    q.kbps !== undefined && t('call.kbps', { n: q.kbps }),
    q.rtt !== undefined && t('call.ms', { n: q.rtt }),
  ].filter(Boolean);
  return (
    <div class="call-quality">
      <button type="button" class={'call-q ' + q.level} aria-expanded={open} onClick={() => setOpen(!open)}>
        <i aria-hidden="true" /> {t('call.q.' + q.level)}
      </button>
      {open && <small>{facts.join(' · ')}</small>}
    </div>
  );
}

const peerName = (c: CallView) => findChat(c.chat)?.members.find((m) => m.id === c.peer)?.name ?? '';

// remoteShown: their camera is on and its picture is here. Off (they say
// so over the data channel): show the avatar, not a frozen or black
// picture. An older app sends no state: go by the call type.
const remoteShown = (c: CallView) => (c.peerCamOff === undefined ? c.video : !c.peerCamOff) && !!c.remote?.getVideoTracks().length;

function statusOf(c: CallView): string {
  if (c.phase === 'outgoing') return t('call.calling');
  if (c.phase === 'incoming') return c.video ? t('call.incomingVideo') : t('call.incomingAudio');
  if (c.phase === 'connecting') return t('call.connecting');
  return c.reconnecting ? t('call.reconnecting') : fmtDuration(Date.now() - (c.since ?? Date.now()));
}

// ---------- the floating window ----------

// Document Picture-in-Picture (Chrome, Edge on computers): a small window
// above all others with the call in it. Safari floats only a <video>.
type DocPip = { requestWindow(o: { width: number; height: number }): Promise<Window> };
const docPip = (window as Window & { documentPictureInPicture?: DocPip }).documentPictureInPicture;
let pipWindow: Window | null = null;

export const canFloat = (c: CallView) => c.phase === 'active' && (!!docPip || (document.pictureInPictureEnabled && remoteShown(c)));

// floatVideo: the other side's video alone in the browser's own floating
// window (Safari, or when the document window is refused).
async function floatVideo() {
  const v = document.querySelector<HTMLVideoElement>('video[data-remote]');
  if (!v) throw new Error('no video');
  await v.requestPictureInPicture();
}

// One window at a time, also when the button and the browser ask at once.
let opening: Promise<void> | null = null;
export function floatCall(): Promise<void> {
  return (opening ??= openFloat().finally(() => (opening = null)));
}

async function openFloat() {
  if (!docPip) return floatVideo();
  if (pipWindow) return;
  let w: Window;
  try {
    w = await docPip.requestWindow({ width: 320, height: 400 });
  } catch (e) {
    if (call.value && remoteShown(call.value)) return floatVideo();
    throw e;
  }
  // The app's own styles; the window's address is about:blank, so links
  // need their full address.
  for (const l of document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')) {
    const n = w.document.createElement('link');
    n.rel = 'stylesheet';
    n.href = l.href;
    w.document.head.append(n);
  }
  for (const s of document.querySelectorAll('style')) w.document.head.append(s.cloneNode(true));
  const root = w.document.documentElement;
  root.dataset.theme = document.documentElement.dataset.theme ?? '';
  root.dataset.design = document.documentElement.dataset.design ?? '';
  root.style.fontSize = document.documentElement.style.fontSize; // the text size setting
  root.lang = document.documentElement.lang;
  w.document.title = document.title;
  pipWindow = w;
  render(<FloatingCall win={w} />, w.document.body);
  w.addEventListener('pagehide', () => {
    render(null, w.document.body);
    if (pipWindow === w) pipWindow = null;
  });
}

// FloatingCall: the other side (or their avatar), the time and two buttons.
// The call's sound keeps playing in the main window. The app lock hides
// who it is, as it hides the app.
function FloatingCall(props: { win: Window }) {
  const c = call.value;
  const hidden = locked.value;
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!c) props.win.close(); // the call is over: so is its window
  }, [c?.id]);
  if (!c) return null;
  const chat = findChat(c.chat);
  return (
    <div class="pip-call">
      {hidden ? (
        <Icon name="lock" size={48} />
      ) : remoteShown(c) ? (
        <video ref={attach(c.remote)} class="pip-video" data-remote autoPlay playsInline muted />
      ) : (
        <Avatar id={c.peer} name={peerName(c)} size={96} src={chat && chatPicture(chat)} />
      )}
      <div class="pip-bar">
        <span class="pip-who">
          <b>{hidden ? '' : peerName(c)}</b>
          <small>{statusOf(c)}</small>
        </span>
        {talkMode.value ? <TalkButton hold={talkHold} muted={c.muted} /> : <IconButton icon={c.muted ? 'micOff' : 'mic'} label={c.muted ? t('call.unmute') : t('call.mute')} onClick={toggleMute} />}
        <IconButton icon="callEnd" label={t('call.hangup')} class="danger" onClick={() => hangup()} />
      </div>
    </div>
  );
}

// FullscreenButton lives as long as a screen is the big picture: when it goes,
// whatever the reason, the display has nothing left to show.
function FullscreenButton() {
  useEffect(() => () => setFullscreen(false), []);
  return (
    <IconButton
      icon={fullscreen.value ? 'shrink' : 'fill'}
      label={t(fullscreen.value ? 'call.fullscreenExit' : 'call.fullscreen')}
      class="call-fit"
      onClick={() => setFullscreen(!fullscreen.value)}
    />
  );
}

// CallAudio plays a call: the voice, and the other side's music at its own
// volume. Remote <video> elements are muted (no echo). It sits at the root of
// the app, outside CallScreen: the app lock takes all of Main away, and the
// call must stay audible behind it.
export function CallAudio() {
  const c = call.value;
  const sink = speaker.value;
  // Playback also runs behind the app lock, with no CallScreen mounted.
  // Reset before attaching a new call, so its first sound has its own level.
  if (c) voiceForCall(c.id);
  const voice = voiceVolume.value;
  const music = musicVolume.value;
  if (!c) return null;
  const play = (stream: MediaStream | undefined, volume: number) => (el: HTMLAudioElement | null) => {
    attach(stream)(el);
    if (!el) return;
    el.volume = volume;
    if (canPickOutput && el.sinkId !== sink) el.setSinkId(sink).catch(() => {});
  };
  return (
    <>
      <audio ref={play(c.remote, voice)} autoPlay />
      <audio ref={play(c.musicIn, music)} autoPlay />
    </>
  );
}

// CallScreen covers the app while a call rings or runs, or shrinks to a
// strip when minimized.
export function CallScreen() {
  const c = call.value;
  const hold = usePushToTalk(c?.id, c?.phase === 'active', setMuted);
  const dialog = useRef<HTMLDialogElement>(null);
  const [, tick] = useState(0);
  const [picker, setPicker] = useState(false);
  const [tileRatio, setTileRatio] = useState('3 / 4'); // the minimized tile takes the picture's own shape
  const [fxOpen, setFxOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null); // the call's own menu
  // The big picture is theirs; a double tap on the small one swaps them.
  const [swapped, setSwapped] = useState(false);
  const [thumbSize, setThumbSize] = useState({ w: 3, h: 4 }); // the small picture's own shape, rotations too
  const lastTap = useRef<Tap | null>(null);
  const drag = useRef<{ px: number; py: number; left: number; top: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const mini = !!c && minimized.value && c.phase !== 'incoming';
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!c) minimized.value = false; // the next call opens full screen
    // Nothing of the last call stays open over the next one's buttons.
    setSwapped(false);
    setPicker(false);
    setFxOpen(false);
    setMenu(null);
    setThumbSize({ w: 3, h: 4 });
  }, [c?.id]);
  useEffect(() => {
    if (mini || c?.phase !== 'active') setMenu(null);
  }, [mini, c?.phase]);
  // Chrome 142+ opens the floating window by itself when the person
  // switches tabs mid-call (the camera or microphone in use).
  useEffect(() => {
    if (!docPip || c?.phase !== 'active') return;
    const action = 'enterpictureinpicture' as MediaSessionAction;
    try {
      navigator.mediaSession.setActionHandler(action, () => void floatCall().catch(() => {}));
    } catch {
      return; // an older browser without this action
    }
    return () => navigator.mediaSession.setActionHandler(action, null);
  }, [c?.phase]);
  // A modal <dialog>: focus moves in and the app behind turns inert.
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, [c?.id, mini]);
  if (!c) return null;

  const chat = findChat(c.chat);
  const name = peerName(c);
  const theirVideo = remoteShown(c);
  const status = statusOf(c);
  // The big and the small picture: theirs big unless swapped, which needs
  // both. The self view is mirrored like a mirror, except for the back
  // camera and a shared screen (text must read right).
  const mine = c.video && !c.camOff && c.local?.getVideoTracks().length ? c.local : undefined;
  const theirs = theirVideo ? c.remote : undefined;
  const canSwap = !!mine && !!theirs;
  const swap = swapped && canSwap;
  const big = swap ? mine : theirs;
  const small = swap ? theirs : mine;
  const bigScreen = swap ? !!c.screen : !!c.peerScreen; // a screen is always shown whole
  const mirror = !c.screen && c.local?.getVideoTracks()[0]?.getSettings().facingMode !== 'environment';
  // Safari floats the big <video> itself: leave that first, or it would
  // float our own camera once swapped.
  const toggleSwap = () => {
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    setSwapped(!swap);
  };

  const expand = () => (minimized.value = false);
  // Their profile is this chat's info page, behind the call.
  const profile = () => {
    minimized.value = true;
    go(`c/${c.chat}/info`);
  };

  if (mini)
    return (
      <>
        <div class="call-bar" role="region" aria-label={t('call.ongoing', { name })}>
          <button type="button" class="call-bar-main" onClick={expand} aria-label={t('call.expand')}>
            <Icon name={c.video ? 'videocam' : 'phone'} size={18} />
            <b>{name}</b>
            <span>{status}</span>
          </button>
          {talkMode.value ? <TalkButton hold={talkHold} muted={c.muted} /> : <IconButton icon={c.muted ? 'micOff' : 'mic'} label={c.muted ? t('call.unmute') : t('call.mute')} onClick={toggleMute} />}
          <IconButton icon="callEnd" label={t('call.hangup')} class="danger" onClick={() => hangup()} />
        </div>
        {theirVideo && (
          <button type="button" class="call-tile" style={{ aspectRatio: tileRatio }} onClick={expand} aria-label={t('call.expand')}>
            <video
              ref={attach(c.remote)}
              data-remote
              autoPlay
              playsInline
              muted
              onResize={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setTileRatio(`${v.videoWidth} / ${v.videoHeight}`);
              }}
            />
          </button>
        )}
      </>
    );

  return (
    <dialog
      ref={dialog}
      class={'call-screen' + (theirVideo ? ' has-video' : '')}
      aria-label={name}
      onCancel={(e) => e.preventDefault() /* Escape must not end a call */}
      onContextMenu={(e) => {
        e.preventDefault(); // the browser's menu would offer to save or pause a video
        if (c.phase === 'active' && !(e.target as Element).closest('button, input, .modal, .menu-layer')) setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {c.phase !== 'incoming' && (
        <>
          <IconButton icon="down" label={t('call.minimize')} class="call-minimize" onClick={() => (minimized.value = true)} />
          <IconButton icon="tune" label={t('call.settings')} class="call-settings" aria-haspopup="dialog" onClick={() => setPicker(true)} />
        </>
      )}
      {big && (
        <video
          ref={attach(big)}
          class={'call-remote' + (swap && mirror ? ' mirror' : '')}
          style={{ objectFit: bigScreen ? 'contain' : callFit.value }}
          data-remote={!swap || undefined}
          autoPlay
          playsInline
          muted
        />
      )}
      {big && !bigScreen && (
        <IconButton
          icon={callFit.value === 'contain' ? 'fill' : 'fit'}
          label={callFit.value === 'contain' ? t('call.fill') : t('call.fit')}
          class="call-fit"
          onClick={() => (callFit.value = callFit.value === 'contain' ? 'cover' : 'contain')}
        />
      )}
      {big && bigScreen && canFullscreen && <FullscreenButton />}
      {small && (
        // A button: a double tap or click swaps; a keyboard or screen
        // reader's click (no pointer, detail 0) swaps at once. Dragged, it
        // moves within .call-room (selfPos). Not `disabled` with nothing to
        // swap: a disabled button gets no pointer events, nor a drag.
        <div class="call-room">
          <button
            type="button"
            class={'call-local' + (!swap && mirror ? ' mirror' : '') + (dragging ? ' dragging' : '')}
            style={{
              aspectRatio: `${thumbSize.w} / ${thumbSize.h}`,
              width: tileWidth(thumbSize.w, thumbSize.h),
              left: `${selfPos.value[0] * 100}%`,
              top: `${selfPos.value[1] * 100}%`,
              translate: `${-selfPos.value[0] * 100}% ${-selfPos.value[1] * 100}%`,
            }}
            aria-disabled={!canSwap || undefined}
            aria-label={t('call.swap')}
            title={canSwap ? t('call.swap') : undefined}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              const el = e.currentTarget;
              const r = el.getBoundingClientRect();
              const box = el.parentElement!.getBoundingClientRect();
              drag.current = { px: e.clientX, py: e.clientY, left: r.left - box.left, top: r.top - box.top, moved: false };
              el.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.px;
              const dy = e.clientY - d.py;
              if (!d.moved && Math.hypot(dx, dy) < 6) return; // a tap jitters, a drag moves
              if (!d.moved) setDragging(true);
              d.moved = true;
              const el = e.currentTarget;
              const room = el.parentElement!.getBoundingClientRect();
              selfPos.value = placeTile({ w: room.width, h: room.height }, { w: el.offsetWidth, h: el.offsetHeight }, d.left + dx, d.top + dy);
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              setDragging(false);
              if (d?.moved) return remember('selfTile', selfPos.value.join(','));
              if (e.button !== 0 || !canSwap) return;
              const now = { t: e.timeStamp, x: e.clientX, y: e.clientY };
              if (isDoubleTap(lastTap.current, now)) {
                lastTap.current = null;
                toggleSwap();
              } else lastTap.current = now;
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(false);
            }}
            onClick={(e) => e.detail === 0 && canSwap && toggleSwap()}
          >
            <video
              ref={attach(small)}
              data-remote={swap || undefined}
              autoPlay
              playsInline
              muted
              onResize={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setThumbSize({ w: v.videoWidth, h: v.videoHeight });
              }}
            />
          </button>
        </div>
      )}
      {c.phase === 'active' && c.q && <QualityBadge q={c.q} />}
      <div class="call-who" {...(c.phase === 'active' ? { tabIndex: 0, onKeyDown: menuKey((x, y) => setMenu({ x, y })) } : {})}>
        {!theirVideo && <Avatar id={c.peer} name={name} size={120} src={chat && chatPicture(chat)} />}
        <h2>{name}</h2>
        <p>{status}</p>
        {c.phase === 'active' && c.peerScreen && theirVideo && (
          <p class="call-note">
            <Icon name="screen" size={16} /> {t('call.peerScreen')}
          </p>
        )}
        {c.phase === 'active' && c.peerMusic && (
          <div class="call-note call-music">
            <Icon name="music" size={16} /> {t('call.peerMusic')}
            <StreamVolume label={t('call.streamVolume')} value={musicVolume.value} onChange={setMusicVolume} />
          </div>
        )}
        {c.phase === 'active' && c.peerMuted && (
          <p class="call-note">
            <Icon name="micOff" size={16} /> {t('call.peerMuted')}
          </p>
        )}
        {c.phase === 'active' && c.peerBattery && <BatteryNote b={c.peerBattery} />}
        {c.phase === 'active' && <span class="sr-only">{t('call.menuHint')}</span>}
        {/* Announces phase changes only, not every tick of the timer. */}
        <p class="sr-only" aria-live="polite">
          {c.phase === 'active' ? (c.reconnecting ? t('call.reconnecting') : t('call.connected')) : status}
        </p>
      </div>
      {fxOpen && c.video && !c.camOff && !c.screen && (
        <div class="fx-tray">
          <FxRow label={t('call.effects')} none={t('fx.none')} items={EFFECTS} on={c.effect} names="fx" busy={c.effectLoading} pick={setEffect} />
          <FxRow label={t('call.background')} none={t('bg.none')} items={BACKGROUNDS} on={c.bg} names="bg" busy={c.effectLoading} pick={setBackground} />
        </div>
      )}
      {c.effectLoading && (
        <p class="fx-loading" role="status">
          {t('fx.loading')}
        </p>
      )}
      <div class="call-controls">
        {c.phase === 'incoming' ? (
          <>
            <Btn icon="callEnd" label={t('call.decline')} tone="red" onClick={decline} />
            <Btn icon="phone" label={t('call.accept')} tone="green" onClick={() => accept(false)} />
            {c.video && <Btn icon="videocam" label={t('call.acceptVideo')} tone="green" onClick={() => accept(true)} />}
          </>
        ) : (
          <>
            {talkMode.value ? <TalkButton hold={hold} muted={c.muted} full /> : <Btn icon={c.muted ? 'micOff' : 'mic'} label={c.muted ? t('call.unmute') : t('call.mute')} tone={c.muted ? 'on' : undefined} onClick={toggleMute} />}
            {(c.canVideo ?? c.video) && !c.screen && (
              <Btn
                icon={c.camOff ? 'videocamOff' : 'videocam'}
                label={c.camOff ? t('call.camOn') : t('call.camOff')}
                tone={c.camOff ? 'on' : undefined}
                onClick={toggleCamera}
              />
            )}
            {c.video && !c.camOff && !c.screen && cameras().length > 1 && <Btn icon="flip" label={t('call.switch')} onClick={switchCamera} />}
            {canShareScreen && c.phase === 'active' && (c.canVideo ?? c.video) && (
              <Btn
                icon={c.screen ? 'screenStop' : 'screen'}
                label={c.screen ? t('call.screenStop') : t('call.screen')}
                tone={c.screen ? 'on' : undefined}
                onClick={() => void (c.screen ? stopScreen() : shareScreen())}
              />
            )}
            {c.video && !c.camOff && !c.screen && (
              <Btn
                icon="sparkle"
                label={t('call.effects')}
                tone={c.effect || fxOpen ? 'on' : undefined}
                expanded={fxOpen}
                onClick={() => setFxOpen(!fxOpen)}
              />
            )}
            {canFloat(c) && <Btn icon="pip" label={t('call.pip')} onClick={() => void floatCall().catch(() => showToast(t('call.pipFailed')))} />}
            <Btn icon="callEnd" label={t('call.hangup')} tone="red" onClick={() => hangup()} />
          </>
        )}
      </div>
      {picker && (
        <CallSettings
          onClose={() => setPicker(false)}
          mic={c.local?.getAudioTracks()[0]?.getSettings().deviceId}
          // The camera in use, or (off, or the screen shown) the one that comes back.
          cam={(!c.camOff && !c.screen && c.local?.getVideoTracks()[0]?.getSettings().deviceId) || remembered('callCam')}
          onMic={selectMic}
          onCam={selectCamera}
          onSpeaker={selectSpeaker}
          reopen={reopenMic}
          diagnostics={exportCallDiagnostics}
          onNetwork={selectNetworkMode}
          networkReduced={!!c.networkReduced}
          onVideoOff={stopOwnVideo}
        >
          <Volumes name={name} music={c.peerMusic} />
        </CallSettings>
      )}
      {menu && (
        <CallMenu label={name} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onProfile={profile}>
          <Volumes name={name} music={c.peerMusic} />
        </CallMenu>
      )}
    </dialog>
  );
}

export function callLabel(cl: CallLog, mine: boolean): string {
  const dur = cl.d ? ` · ${fmtDuration(cl.d)}` : '';
  switch (cl.s) {
    case 'ok':
      return (mine ? t('call.outgoing') : t('call.incoming')) + dur;
    case 'missed':
      return mine ? t('call.noAnswer') : t('call.missed');
    case 'declined':
      return t('call.declined');
    case 'busy':
      return mine ? t('call.busy') : t('call.missed');
    default:
      return t('call.failed');
  }
}

import { signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  accept,
  call,
  type CallView,
  canShareScreen,
  decline,
  hangup,
  type Quality,
  selectCamera,
  selectMic,
  selectSpeaker,
  setEffect,
  shareScreen,
  speaker,
  stopScreen,
  switchCamera,
  toggleCamera,
  toggleMute,
} from '../lib/call';
import { cameras, canPickOutput, deviceName, microphones, remembered, speakers } from '../lib/devices';
import { EFFECTS } from '../lib/effects';
import { t } from '../lib/i18n';
import { fmtDuration } from '../lib/recorder';
import { locked } from '../lib/lock';
import { callFit } from '../lib/prefs';
import { isDoubleTap, type Tap, tileWidth } from '../lib/tap';
import { type CallLog, chatPicture, findChat, showToast } from '../lib/store';
import { Avatar, Icon, IconButton, type IconName, Modal } from './ui';

// A minimized call shrinks to a strip at the top (and, with video, a small
// tile) so the app stays usable; the sound keeps playing.
export const minimized = signal(false);

// attach sets a stream on a media element whenever the element appears:
// the self view is a new element each time the camera comes back on.
const attach = (s?: MediaStream) => (el: HTMLMediaElement | null) => {
  if (el && el.srcObject !== (s ?? null)) el.srcObject = s ?? null;
};

// DevicePicker: which camera, microphone and speakers the call uses, all
// listed even when there is one (to see which). On Android the
// "microphones" include the earpiece and the speakerphone.
function DevicePicker(props: { onClose: () => void }) {
  const c = call.value;
  const mic = c?.local?.getAudioTracks()[0]?.getSettings().deviceId;
  // The camera in use, or (off, or the screen shown) the one that comes back.
  const cam = (!c?.camOff && !c?.screen && c?.local?.getVideoTracks()[0]?.getSettings().deviceId) || remembered('callCam');
  const cams = cameras();
  const ins = microphones();
  const outs = speakers();
  return (
    <Modal label={t('call.devices')} onClose={props.onClose} class="device-picker">
      <h2>{t('call.devices')}</h2>
      {cams.length > 0 && (
        <fieldset>
          <legend>{t('call.audio.camera')}</legend>
          {cams.map((d, i) => (
            <label key={d.deviceId} class="row">
              <input type="radio" name="cam" checked={d.deviceId === cam} onChange={() => void selectCamera(d.deviceId)} />
              <span>{deviceName(d, i)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {ins.length > 0 && (
        <fieldset>
          <legend>{t('call.audio.mic')}</legend>
          {ins.map((d, i) => (
            <label key={d.deviceId} class="row">
              <input type="radio" name="mic" checked={d.deviceId === mic} onChange={() => void selectMic(d.deviceId)} />
              <span>{deviceName(d, i)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {outs.length > 0 && (
        <fieldset>
          <legend>{t('call.audio.out')}</legend>
          {outs.map((d, i) => (
            <label key={d.deviceId} class="row">
              <input
                type="radio"
                name="speaker"
                checked={d.deviceId === (speaker.value || 'default')}
                onChange={() => selectSpeaker(d.deviceId)}
              />
              <span>{deviceName(d, i)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <button type="button" class="btn secondary" onClick={props.onClose}>
        {t('common.done')}
      </button>
    </Modal>
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
        <IconButton icon={c.muted ? 'micOff' : 'mic'} label={c.muted ? t('call.unmute') : t('call.mute')} onClick={toggleMute} />
        <IconButton icon="callEnd" label={t('call.hangup')} class="danger" onClick={() => hangup()} />
      </div>
    </div>
  );
}

// CallScreen covers the app while a call rings or runs, or shrinks to a
// strip when minimized. Sound plays through one <audio> element, first in
// both layouts so it stays mounted across them; remote <video> elements are
// muted (no echo).
export function CallScreen() {
  const c = call.value;
  const dialog = useRef<HTMLDialogElement>(null);
  const [, tick] = useState(0);
  const [picker, setPicker] = useState(false);
  const [tileRatio, setTileRatio] = useState('3 / 4'); // the minimized tile takes the picture's own shape
  const [fxOpen, setFxOpen] = useState(false);
  // The big picture is theirs; a double tap on the small one swaps them.
  const [swapped, setSwapped] = useState(false);
  const [thumbSize, setThumbSize] = useState({ w: 3, h: 4 }); // the small picture's own shape, rotations too
  const lastTap = useRef<Tap | null>(null);
  const mini = !!c && minimized.value && c.phase !== 'incoming';
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!c) minimized.value = false; // the next call opens full screen
    setSwapped(false);
  }, [c?.id]);
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
  const sink = speaker.value;
  const audioRef = (el: HTMLAudioElement | null) => {
    attach(c.remote)(el);
    if (el && canPickOutput && el.sinkId !== sink) el.setSinkId(sink).catch(() => {});
  };
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

  const expand = () => (minimized.value = false);
  const audio = <audio ref={audioRef} autoPlay />;

  if (mini)
    return (
      <>
        {audio}
        <div class="call-bar" role="region" aria-label={t('call.ongoing', { name })}>
          <button type="button" class="call-bar-main" onClick={expand} aria-label={t('call.expand')}>
            <Icon name={c.video ? 'videocam' : 'phone'} size={18} />
            <b>{name}</b>
            <span>{status}</span>
          </button>
          <IconButton icon={c.muted ? 'micOff' : 'mic'} label={c.muted ? t('call.unmute') : t('call.mute')} onClick={toggleMute} />
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
    <>
      {audio}
      <dialog
        ref={dialog}
        class={'call-screen' + (theirVideo ? ' has-video' : '')}
        aria-label={name}
        onCancel={(e) => e.preventDefault() /* Escape must not end a call */}
      >
        {c.phase !== 'incoming' && (
          <IconButton icon="down" label={t('call.minimize')} class="call-minimize" onClick={() => (minimized.value = true)} />
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
        {small && (
          <div
            class={'call-local' + (!swap && mirror ? ' mirror' : '')}
            style={{ aspectRatio: `${thumbSize.w} / ${thumbSize.h}`, width: tileWidth(thumbSize.w, thumbSize.h) }}
            role={canSwap ? 'button' : undefined}
            tabIndex={canSwap ? 0 : undefined}
            aria-label={canSwap ? t('call.swap') : undefined}
            title={canSwap ? t('call.swap') : undefined}
            onPointerUp={
              canSwap
                ? (e) => {
                    const now = { t: e.timeStamp, x: e.clientX, y: e.clientY };
                    if (isDoubleTap(lastTap.current, now)) {
                      lastTap.current = null;
                      setSwapped(!swap);
                    } else lastTap.current = now;
                  }
                : undefined
            }
            onKeyDown={canSwap ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSwapped(!swap)) : undefined}
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
          </div>
        )}
        {c.phase === 'active' && c.q && <QualityBadge q={c.q} />}
        <div class="call-who">
          {!theirVideo && <Avatar id={c.peer} name={name} size={120} src={chat && chatPicture(chat)} />}
          <h2>{name}</h2>
          <p>{status}</p>
          {c.phase === 'active' && c.peerScreen && theirVideo && (
            <p class="call-note">
              <Icon name="screen" size={16} /> {t('call.peerScreen')}
            </p>
          )}
          {c.phase === 'active' && c.peerMuted && (
            <p class="call-note">
              <Icon name="micOff" size={16} /> {t('call.peerMuted')}
            </p>
          )}
          {c.phase === 'active' && c.peerBattery && <BatteryNote b={c.peerBattery} />}
          {/* Announces phase changes only, not every tick of the timer. */}
          <p class="sr-only" aria-live="polite">
            {c.phase === 'active' ? (c.reconnecting ? t('call.reconnecting') : t('call.connected')) : status}
          </p>
        </div>
        {fxOpen && c.video && !c.camOff && (
          <div class="fx-tray" role="group" aria-label={t('call.effects')}>
            <button
              type="button"
              class="fx"
              aria-pressed={!c.effect}
              title={t('fx.none')}
              aria-label={t('fx.none')}
              disabled={c.effectLoading}
              onClick={() => void setEffect(null)}
            >
              <Icon name="close" size={22} />
            </button>
            {EFFECTS.map((e) => (
              <button
                key={e.id}
                type="button"
                class="fx"
                aria-pressed={c.effect === e.id}
                title={t(`fx.${e.id}`)}
                aria-label={t(`fx.${e.id}`)}
                disabled={c.effectLoading}
                onClick={() => void setEffect(e.id)}
              >
                <span aria-hidden="true">{e.icon}</span>
              </button>
            ))}
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
              <Btn icon={c.muted ? 'micOff' : 'mic'} label={c.muted ? t('call.unmute') : t('call.mute')} tone={c.muted ? 'on' : undefined} onClick={toggleMute} />
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
              <Btn icon="devices" label={t('call.devices')} expanded={picker} onClick={() => setPicker(true)} />
              {canFloat(c) && <Btn icon="pip" label={t('call.pip')} onClick={() => void floatCall().catch(() => showToast(t('call.pipFailed')))} />}
              <Btn icon="callEnd" label={t('call.hangup')} tone="red" onClick={() => hangup()} />
            </>
          )}
        </div>
        {picker && <DevicePicker onClose={() => setPicker(false)} />}
      </dialog>
    </>
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

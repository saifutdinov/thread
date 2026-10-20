import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  accept,
  call,
  decline,
  hangup,
  type Quality,
  selectMic,
  selectSpeaker,
  setEffect,
  speaker,
  switchCamera,
  toggleCamera,
  toggleMute,
} from '../lib/call';
import { cameras, canPickOutput, deviceName, microphones, speakers } from '../lib/devices';
import { EFFECTS } from '../lib/effects';
import { t } from '../lib/i18n';
import { fmtDuration } from '../lib/recorder';
import { type CallLog, chatPicture, findChat } from '../lib/store';
import { Avatar, Icon, IconButton, type IconName, Modal } from './ui';

// A minimized call shrinks to a strip at the top (and, with video, a small
// tile) so the app stays usable; the sound keeps playing.
export const minimized = signal(false);

// attach sets a stream on a media element whenever the element appears:
// the self view is a new element each time the camera comes back on.
const attach = (s?: MediaStream) => (el: HTMLMediaElement | null) => {
  if (el && el.srcObject !== (s ?? null)) el.srcObject = s ?? null;
};

// AudioPicker: which microphone and which speakers the call uses. On
// Android the "microphones" include the earpiece and the speakerphone.
function AudioPicker(props: { onClose: () => void }) {
  const mic = call.value?.local?.getAudioTracks()[0]?.getSettings().deviceId;
  const ins = microphones();
  const outs = speakers();
  return (
    <Modal label={t('call.audio.title')} onClose={props.onClose} class="device-picker">
      <h2>{t('call.audio.title')}</h2>
      {ins.length > 1 && (
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
      {outs.length > 1 && (
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
  const mini = !!c && minimized.value && c.phase !== 'incoming';
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!c) minimized.value = false; // the next call opens full screen
  }, [c?.id]);
  // A modal <dialog>: focus moves in and the app behind turns inert.
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, [c?.id, mini]);
  if (!c) return null;

  const chat = findChat(c.chat);
  const name = chat?.members.find((m) => m.id === c.peer)?.name ?? '';
  // Their camera off (they say so over the data channel): show the avatar,
  // not a frozen or black picture.
  // An older app on the other side sends no state: go by the call type.
  const theyShow = c.peerCamOff === undefined ? c.video : !c.peerCamOff;
  const theirVideo = theyShow && !!c.remote?.getVideoTracks().length;
  const sink = speaker.value;
  const audioRef = (el: HTMLAudioElement | null) => {
    attach(c.remote)(el);
    if (el && canPickOutput && el.sinkId !== sink) el.setSinkId(sink).catch(() => {});
  };
  const canPickAudio = microphones().length > 1 || speakers().length > 1;
  const status =
    c.phase === 'outgoing'
      ? t('call.calling')
      : c.phase === 'incoming'
        ? c.video
          ? t('call.incomingVideo')
          : t('call.incomingAudio')
        : c.phase === 'connecting'
          ? t('call.connecting')
          : c.reconnecting
            ? t('call.reconnecting')
            : fmtDuration(Date.now() - (c.since ?? Date.now()));

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
        {theirVideo && <video ref={attach(c.remote)} class="call-remote" autoPlay playsInline muted />}
        {c.video && c.local && !c.camOff && <video ref={attach(c.local)} class="call-local" autoPlay playsInline muted />}
        {c.phase === 'active' && c.q && <QualityBadge q={c.q} />}
        <div class="call-who">
          {!theirVideo && <Avatar id={c.peer} name={name} size={120} src={chat && chatPicture(chat)} />}
          <h2>{name}</h2>
          <p>{status}</p>
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
              {(c.canVideo ?? c.video) && (
                <Btn
                  icon={c.camOff ? 'videocamOff' : 'videocam'}
                  label={c.camOff ? t('call.camOn') : t('call.camOff')}
                  tone={c.camOff ? 'on' : undefined}
                  onClick={toggleCamera}
                />
              )}
              {c.video && !c.camOff && cameras().length > 1 && <Btn icon="flip" label={t('call.switch')} onClick={switchCamera} />}
              {c.video && !c.camOff && (
                <Btn
                  icon="sparkle"
                  label={t('call.effects')}
                  tone={c.effect || fxOpen ? 'on' : undefined}
                  expanded={fxOpen}
                  onClick={() => setFxOpen(!fxOpen)}
                />
              )}
              {canPickAudio && <Btn icon="volume" label={t('call.sound')} onClick={() => setPicker(true)} />}
              <Btn icon="callEnd" label={t('call.hangup')} tone="red" onClick={() => hangup()} />
            </>
          )}
        </div>
        {picker && <AudioPicker onClose={() => setPicker(false)} />}
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

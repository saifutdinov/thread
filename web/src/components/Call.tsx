import { useEffect, useRef, useState } from 'preact/hooks';
import {
  accept,
  call,
  decline,
  hangup,
  type Quality,
  selectMic,
  selectSpeaker,
  speaker,
  switchCamera,
  toggleCamera,
  toggleMute,
} from '../lib/call';
import { cameras, canPickOutput, deviceName, microphones, speakers } from '../lib/devices';
import { t } from '../lib/i18n';
import { fmtDuration } from '../lib/recorder';
import { type CallLog, chatPicture, findChat } from '../lib/store';
import { Avatar, Icon, type IconName, Modal } from './ui';

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

function Btn(props: { icon: IconName; label: string; onClick: () => void; tone?: 'red' | 'green' | 'on' }) {
  return (
    <button type="button" class={'call-btn ' + (props.tone ?? '')} onClick={props.onClick} aria-label={props.label} title={props.label}>
      <Icon name={props.icon} size={28} />
      <small>{props.label}</small>
    </button>
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

// CallScreen covers the app while a call rings or runs. Sound always plays
// through an <audio> element; the remote <video> is muted to avoid echo.
export function CallScreen() {
  const c = call.value;
  const dialog = useRef<HTMLDialogElement>(null);
  const [, tick] = useState(0);
  const [picker, setPicker] = useState(false);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  // A modal <dialog>: focus moves in and the app behind turns inert.
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, [c?.id]);
  if (!c) return null;

  const chat = findChat(c.chat);
  const name = chat?.members.find((m) => m.id === c.peer)?.name ?? '';
  // Their camera off (they say so over the data channel): show the avatar,
  // not a frozen or black picture.
  const theirVideo = c.video && !c.peerCamOff && !!c.remote?.getVideoTracks().length;
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

  return (
    <dialog
      ref={dialog}
      class={'call-screen' + (theirVideo ? ' has-video' : '')}
      aria-label={name}
      onCancel={(e) => e.preventDefault() /* Escape must not end a call */}
    >
      <audio ref={audioRef} autoPlay />
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
        {/* Announces phase changes only, not every tick of the timer. */}
        <p class="sr-only" aria-live="polite">
          {c.phase === 'active' ? (c.reconnecting ? t('call.reconnecting') : t('call.connected')) : status}
        </p>
      </div>
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
            {c.video && (
              <Btn
                icon={c.camOff ? 'videocamOff' : 'videocam'}
                label={c.camOff ? t('call.camOn') : t('call.camOff')}
                tone={c.camOff ? 'on' : undefined}
                onClick={toggleCamera}
              />
            )}
            {c.video && !c.camOff && cameras().length > 1 && <Btn icon="flip" label={t('call.switch')} onClick={switchCamera} />}
            {canPickAudio && <Btn icon="volume" label={t('call.sound')} onClick={() => setPicker(true)} />}
            <Btn icon="callEnd" label={t('call.hangup')} tone="red" onClick={() => hangup()} />
          </>
        )}
      </div>
      {picker && <AudioPicker onClose={() => setPicker(false)} />}
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

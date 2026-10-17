import { useEffect, useRef, useState } from 'preact/hooks';
import { accept, call, decline, hangup, type Quality, switchCamera, toggleCamera, toggleMute } from '../lib/call';
import { t } from '../lib/i18n';
import { fmtDuration } from '../lib/recorder';
import { type CallLog, chatPicture, findChat } from '../lib/store';
import { Avatar, Icon, type IconName } from './ui';

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
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (remoteVideo.current) remoteVideo.current.srcObject = c?.remote ?? null;
    if (remoteAudio.current) remoteAudio.current.srcObject = c?.remote ?? null;
  }, [c?.remote]);
  useEffect(() => {
    if (localVideo.current) localVideo.current.srcObject = c?.local ?? null;
  }, [c?.local]);
  // A modal <dialog>: focus moves in and the app behind turns inert.
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, [c?.id]);
  if (!c) return null;

  const chat = findChat(c.chat);
  const name = chat?.members.find((m) => m.id === c.peer)?.name ?? '';
  const theirVideo = c.video && !!c.remote?.getVideoTracks().length;
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
      <audio ref={remoteAudio} autoPlay />
      {theirVideo && <video ref={remoteVideo} class="call-remote" autoPlay playsInline muted />}
      {c.video && c.local && !c.camOff && <video ref={localVideo} class="call-local" autoPlay playsInline muted />}
      {c.phase === 'active' && c.q && <QualityBadge q={c.q} />}
      <div class="call-who">
        {!theirVideo && <Avatar id={c.peer} name={name} size={120} src={chat && chatPicture(chat)} />}
        <h2>{name}</h2>
        <p>{status}</p>
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
            {c.video && !c.camOff && <Btn icon="flip" label={t('call.switch')} onClick={switchCamera} />}
            <Btn icon="callEnd" label={t('call.hangup')} tone="red" onClick={() => hangup()} />
          </>
        )}
      </div>
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

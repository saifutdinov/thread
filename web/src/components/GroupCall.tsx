import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cameras } from '../lib/devices';
import {
  decline,
  flipGroupCamera,
  groupCall,
  leave,
  type Person,
  reopenGroupMic,
  startGroupAudio,
  startGroupCall,
  toggleGroupCamera,
  toggleGroupMute,
  toggleGroupScreen,
} from '../lib/group';
import { t } from '../lib/i18n';
import { canShareScreen } from '../lib/call';
import { canTune } from '../lib/mic';
import { fmtDuration } from '../lib/recorder';
import { chatPicture, findChat, nameOf, picture } from '../lib/store';
import { chatName } from './ChatList';
import { MicTuning } from './MicTuning';
import { Avatar, Icon, IconButton, type IconName, Modal } from './ui';

// A minimized group call shrinks to a strip, like a 1:1 call (Call.tsx).
export const minimized = signal(false);

function Btn(props: { icon: IconName; label: string; onClick: () => void; tone?: 'red' | 'green' | 'on' }) {
  return (
    <button type="button" class={'call-btn ' + (props.tone ?? '')} onClick={props.onClick} aria-label={props.label} title={props.label}>
      <Icon name={props.icon} size={28} />
      <small>{props.label}</small>
    </button>
  );
}

// Tile: one person, their camera (LiveKit attaches it, so it knows the
// tile is on screen and how big, and fetches that size) or their avatar.
// Speaking is a ring around the tile and, for screen readers, a word.
function Tile(props: { p: Person; chat: number }) {
  const { p } = props;
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    const v = p.video;
    if (!el || !v) return;
    v.attach(el);
    return () => void v.detach(el);
  }, [p.video]);
  const name = p.me ? t('gcall.you') : nameOf(props.chat, p.user);
  const m = findChat(props.chat)?.members.find((x) => x.id === p.user);
  return (
    <li class={'gtile' + (p.speaking ? ' speaking' : '')}>
      {p.video ? (
        <video ref={ref} class={p.me ? 'mirror' : undefined} autoPlay playsInline muted />
      ) : (
        <Avatar id={p.user} name={name} size={72} src={m && picture(props.chat, m.id, m.avatar_v)} />
      )}
      <span class="gtile-name">
        {p.muted && <Icon name="micOff" size={14} />}
        <span>{name}</span>
        {p.speaking && <span class="sr-only">{t('gcall.speaking')}</span>}
        {p.muted && <span class="sr-only">{t('gcall.muted')}</span>}
      </span>
    </li>
  );
}

// ScreenTile: someone's shared screen, whole (never cropped), across the
// grid. Our own shows a note instead: the call inside itself is no use.
function ScreenTile(props: { p: Person; chat: number }) {
  const { p } = props;
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    const v = p.screen;
    if (!el || !v || p.me) return;
    v.attach(el);
    return () => void v.detach(el);
  }, [p.screen, p.me]);
  const name = p.me ? t('gcall.you') : nameOf(props.chat, p.user);
  return (
    <li class={'gtile screen' + (p.me ? ' mine' : '')}>
      {p.me ? <p class="gtile-note">{t('gcall.youShare')}</p> : <video ref={ref} autoPlay playsInline muted />}
      <span class="gtile-name">
        <Icon name="screen" size={14} />
        <span>{t('gcall.screenOf', { name })}</span>
      </span>
    </li>
  );
}

// GroupCallScreen covers the app while a group call rings or runs, or
// shrinks to a strip when minimized.
export function GroupCallScreen() {
  const g = groupCall.value;
  const dialog = useRef<HTMLDialogElement>(null);
  const [, tick] = useState(0);
  const [tuning, setTuning] = useState(false);
  const mini = !!g && minimized.value && g.phase !== 'incoming';
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!g) minimized.value = false; // the next call opens full screen
  }, [g?.id, !g]);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal(); // focus moves in, the app behind turns inert
  }, [g?.chat, g?.phase === 'incoming', mini]);
  if (!g) return null;

  const chat = findChat(g.chat);
  const title = chat ? chatName(chat) : '';
  const others = g.people.filter((p) => !p.me).length;
  const status =
    g.phase === 'connecting'
      ? t('call.connecting')
      : g.reconnecting
        ? t('call.reconnecting')
        : `${fmtDuration(Date.now() - (g.since ?? Date.now()))} · ${t('gcall.people', { n: g.people.length })}`;

  if (g.phase === 'incoming')
    return (
      <dialog ref={dialog} class="call-screen" aria-label={title} onCancel={(e) => e.preventDefault()}>
        <div class="call-who">
          <Avatar id={g.chat} name={title} size={120} group src={chat && chatPicture(chat)} />
          <h2>{title}</h2>
          <p>{t(g.video ? 'gcall.ringVideo' : 'gcall.ring', { name: nameOf(g.chat, g.from ?? 0) })}</p>
        </div>
        <div class="call-controls">
          <Btn icon="callEnd" label={t('call.decline')} tone="red" onClick={decline} />
          <Btn icon="phone" label={t('gcall.join')} tone="green" onClick={() => void startGroupCall(g.chat, false)} />
          {g.video && <Btn icon="videocam" label={t('call.acceptVideo')} tone="green" onClick={() => void startGroupCall(g.chat, true)} />}
        </div>
      </dialog>
    );

  if (mini)
    return (
      <div class="call-bar" role="region" aria-label={t('gcall.ongoing', { name: title })}>
        <button type="button" class="call-bar-main" onClick={() => (minimized.value = false)} aria-label={t('call.expand')}>
          <Icon name="group" size={18} />
          <b>{title}</b>
          <span>{status}</span>
        </button>
        <IconButton icon={g.muted ? 'micOff' : 'mic'} label={g.muted ? t('call.unmute') : t('call.mute')} onClick={() => void toggleGroupMute()} />
        <IconButton icon="callEnd" label={t('gcall.leave')} class="danger" onClick={() => void leave()} />
      </div>
    );

  return (
    <dialog ref={dialog} class="call-screen gcall" aria-label={title} onCancel={(e) => e.preventDefault() /* Escape must not end a call */}>
      <IconButton icon="down" label={t('call.minimize')} class="call-minimize" onClick={() => (minimized.value = true)} />
      <header class="gcall-head">
        <h2>{title}</h2>
        <p>{status}</p>
        {/* Announces joins and leaves, not every tick of the timer. */}
        <p class="sr-only" aria-live="polite">
          {g.phase === 'active' ? t('gcall.people', { n: g.people.length }) : status}
        </p>
      </header>
      <ul class={'gtiles n' + Math.min(g.people.length, 10) + (g.people.some((p) => p.screen && !p.me) ? ' has-screen' : '')} aria-label={t('gcall.participants')}>
        {g.people
          .filter((p) => p.screen)
          .map((p) => (
            <ScreenTile key={p.id + '-screen'} p={p} chat={g.chat} />
          ))}
        {g.people.map((p) => (
          <Tile key={p.id} p={p} chat={g.chat} />
        ))}
      </ul>
      {g.phase === 'active' && others === 0 && <p class="call-note gcall-alone">{t('gcall.alone')}</p>}
      {g.needsTap && (
        <button type="button" class="btn gcall-tap" onClick={startGroupAudio}>
          <Icon name="volume" size={18} /> {t('gcall.tapSound')}
        </button>
      )}
      <div class="call-controls">
        <Btn icon={g.muted ? 'micOff' : 'mic'} label={g.muted ? t('call.unmute') : t('call.mute')} tone={g.muted ? 'on' : undefined} onClick={() => void toggleGroupMute()} />
        <Btn
          icon={g.camOff ? 'videocamOff' : 'videocam'}
          label={g.camOff ? t('call.camOn') : t('call.camOff')}
          tone={g.camOff ? 'on' : undefined}
          onClick={() => void toggleGroupCamera()}
        />
        {!g.camOff && cameras().length > 1 && <Btn icon="flip" label={t('call.switch')} onClick={() => void flipGroupCamera()} />}
        {canShareScreen && g.phase === 'active' && (
          <Btn
            icon={g.sharing ? 'screenStop' : 'screen'}
            label={g.sharing ? t('call.screenStop') : t('call.screen')}
            tone={g.sharing ? 'on' : undefined}
            onClick={() => void toggleGroupScreen()}
          />
        )}
        {canTune && <Btn icon="tune" label={t('mic.button')} onClick={() => setTuning(true)} />}
        <Btn icon="callEnd" label={t('gcall.leave')} tone="red" onClick={() => void leave()} />
      </div>
      {tuning && (
        <Modal label={t('mic.settings')} onClose={() => setTuning(false)} class="device-picker">
          <h2>{t('mic.settings')}</h2>
          <MicTuning reopen={reopenGroupMic} />
          <button type="button" class="btn secondary" onClick={() => setTuning(false)}>
            {t('common.done')}
          </button>
        </Modal>
      )}
    </dialog>
  );
}

import { TalkButton, talkMode, usePushToTalk } from './PushToTalk';
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { menuKey } from '../lib/call-menu';
import { cameras, canSetVolume } from '../lib/devices';
import {
  decline,
  flipGroupCamera,
  groupCall,
  leave,
  type Person,
  groupDevices,
  reopenGroupMic,
  selectGroupCamera,
  selectGroupMic,
  selectGroupSpeaker,
  startGroupAudio,
  startGroupCall,
  toggleGroupCamera,
  toggleGroupMute,
  setGroupMuted,
  exportGroupDiagnostics,
  setParticipantVolume,
  participantVolumes,
  setScreenVolume,
  screenVolumes,
  toggleGroupScreen,
  selectGroupNetworkMode,
  stopGroupVideo,
} from '../lib/group';
import { errText, t } from '../lib/i18n';
import { canShareScreen, selectSpeaker } from '../lib/call';
import { fmtDuration } from '../lib/recorder';
import { go, route } from '../lib/route';
import { chatPicture, findChat, myId, nameOf, openDirect, picture, showToast } from '../lib/store';
import { chatName } from './ChatList';
import { CallMenu } from './CallMenu';
import { CallSettings } from './CallSettings';
import { StreamVolume } from './StreamVolume';
import { Avatar, Icon, IconButton, type IconName } from './ui';

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

type OpenMenu = (id: string, x: number, y: number) => void;

// A tile's menu opens by the right button, a long press on Android, or
// the keyboard on a focused tile. Our own devices have none: a person can
// be in a call twice, and there is no profile to open for ourselves.
function tileMenu(p: Person, open: OpenMenu) {
  if (p.user === myId()) return {};
  return {
    tabIndex: 0,
    onContextMenu: (e: MouseEvent) => open(p.id, e.clientX, e.clientY),
    onKeyDown: menuKey((x, y) => open(p.id, x, y)),
  };
}

// Tile: one person, their camera (LiveKit attaches it, so it knows the
// tile is on screen and how big, and fetches that size) or their avatar.
// Speaking is a ring around the tile and, for screen readers, a word.
function Tile(props: { p: Person; chat: number; onMenu: OpenMenu }) {
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
    <li class={'gtile' + (p.speaking ? ' speaking' : '')} {...tileMenu(p, props.onMenu)}>
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
        {p.user !== myId() && <span class="sr-only">{t('call.menuHint')}</span>}
      </span>
    </li>
  );
}

// ScreenTile: someone's shared screen, whole (never cropped), across the
// grid. Our own shows a note instead: the call inside itself is no use.
function ScreenTile(props: { p: Person; chat: number; onMenu: OpenMenu }) {
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
    <li class={'gtile screen' + (p.me ? ' mine' : '')} {...tileMenu(p, props.onMenu)}>
      {p.me ? <p class="gtile-note">{t('gcall.youShare')}</p> : <video ref={ref} autoPlay playsInline muted />}
      <span class="gtile-name">
        <Icon name="screen" size={14} />
        <span>{t('gcall.screenOf', { name })}</span>
        {p.user !== myId() && <span class="sr-only">{t('call.menuHint')}</span>}
      </span>
    </li>
  );
}

// Volumes: someone's voice and, while they share a screen with sound, that
// sound. iPhones and iPads ignore a page's volume: no sliders there.
function Volumes(props: { p: Person; chat: number }) {
  const { p } = props;
  if (!canSetVolume) return null;
  const name = nameOf(props.chat, p.user);
  return (
    <>
      <label class="participant-volume">
        <span>{t('call.volumeOf', { name })}</span>
        <input type="range" min="0" max="1" step="0.05" value={participantVolumes.value.get(p.id) ?? 1} onInput={(e) => setParticipantVolume(p.id, Number(e.currentTarget.value))} />
      </label>
      {p.screenSound && (
        <StreamVolume label={t('call.streamVolumeOf', { name })} value={screenVolumes.value.get(p.id) ?? 1} onChange={(value) => setScreenVolume(p.id, value)} />
      )}
    </>
  );
}

// TileMenu: what a person's tile offers. Their profile is the info page of
// their direct chat, behind the call.
function TileMenu(props: { p: Person; chat: number; x: number; y: number; onClose: () => void }) {
  const { p, chat } = props;
  async function profile() {
    minimized.value = true;
    try {
      await openDirect(p.user, chat);
      go(`c/${route.value.id}/info`);
    } catch (e) {
      showToast(errText(e));
    }
  }
  return (
    <CallMenu label={nameOf(chat, p.user)} x={props.x} y={props.y} onClose={props.onClose} onProfile={() => void profile()}>
      <Volumes p={p} chat={chat} />
    </CallMenu>
  );
}

// GroupCallScreen covers the app while a group call rings or runs, or
// shrinks to a strip when minimized.
export function GroupCallScreen() {
  const g = groupCall.value;
  const hold = usePushToTalk(g?.id, g?.phase === 'active', setGroupMuted);
  const dialog = useRef<HTMLDialogElement>(null);
  const [, tick] = useState(0);
  const [settings, setSettings] = useState(false); // the call settings window
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null); // a tile's menu
  const mini = !!g && minimized.value && g.phase !== 'incoming';
  const menuFor = menu && g?.people.find((p) => p.id === menu.id);
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
  useEffect(() => {
    if (menu && (mini || !menuFor)) setMenu(null); // the person left, or a restart would bring it back
  }, [mini, !menuFor]);
  if (!g) return null;

  const chat = findChat(g.chat);
  const title = chat ? chatName(chat) : '';
  const others = g.people.filter((p) => !p.me).length;
  const openMenu: OpenMenu = (id, x, y) => setMenu({ id, x, y });
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
        {talkMode.value ? <TalkButton hold={hold} muted={g.muted} /> : <IconButton icon={g.muted ? 'micOff' : 'mic'} label={g.muted ? t('call.unmute') : t('call.mute')} onClick={() => void toggleGroupMute()} />}
        <IconButton icon="callEnd" label={t('gcall.leave')} class="danger" onClick={() => void leave()} />
      </div>
    );

  return (
    <dialog
      ref={dialog}
      class="call-screen gcall"
      aria-label={title}
      onCancel={(e) => e.preventDefault() /* Escape must not end a call */}
      onContextMenu={(e) => e.preventDefault() /* the browser's menu would offer to save or pause a video */}
    >
      <IconButton icon="down" label={t('call.minimize')} class="call-minimize" onClick={() => (minimized.value = true)} />
      <IconButton icon="tune" label={t('call.settings')} class="call-settings" aria-haspopup="dialog" onClick={() => setSettings(true)} />
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
            <ScreenTile key={p.id + '-screen'} p={p} chat={g.chat} onMenu={openMenu} />
          ))}
        {g.people.map((p) => (
          <Tile key={p.id} p={p} chat={g.chat} onMenu={openMenu} />
        ))}
      </ul>
      {g.phase === 'active' && others === 0 && <p class="call-note gcall-alone">{t('gcall.alone')}</p>}
      {g.needsTap && (
        <button type="button" class="btn gcall-tap" onClick={startGroupAudio}>
          <Icon name="volume" size={18} /> {t('gcall.tapSound')}
        </button>
      )}
      <div class="call-controls">
        {talkMode.value ? <TalkButton hold={hold} muted={g.muted} full /> : <Btn icon={g.muted ? 'micOff' : 'mic'} label={g.muted ? t('call.unmute') : t('call.mute')} tone={g.muted ? 'on' : undefined} onClick={() => void toggleGroupMute()} />}
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
        <Btn icon="callEnd" label={t('gcall.leave')} tone="red" onClick={() => void leave()} />
      </div>
      {settings && (
        <CallSettings
          onClose={() => setSettings(false)}
          {...groupDevices()}
          onMic={selectGroupMic}
          onCam={selectGroupCamera}
          onSpeaker={(id) => {
            selectSpeaker(id);
            return selectGroupSpeaker(id);
          }}
          reopen={reopenGroupMic}
          diagnostics={exportGroupDiagnostics}
          onNetwork={selectGroupNetworkMode}
          networkReduced={!!g.networkReduced}
          onVideoOff={stopGroupVideo}
        >
          {g.people.filter((p) => !p.me).map((p) => <Volumes key={p.id} p={p} chat={g.chat} />)}
        </CallSettings>
      )}
      {menu && menuFor && <TileMenu p={menuFor} chat={g.chat} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </dialog>
  );
}

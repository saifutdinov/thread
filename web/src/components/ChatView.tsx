import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { errText, fmtDay, fmtLastSeen, fmtTime, t } from '../lib/i18n';
import { jumbo } from '../lib/emoji';
import { Markup } from '../lib/markup';
import { fmtDuration } from '../lib/recorder';
import { back, go, replace, route } from '../lib/route';
import {
  type Chat,
  chats,
  deleteMessage,
  devicesTick,
  peerTick,
  type Trust,
  trustOf,
  ensureLoaded,
  findChat,
  forwardMessage,
  goChat,
  type LinkCard,
  loadHistory,
  pinMessage,
  summary,
  hasOlder,
  loadOlder,
  markRead,
  messages,
  type Msg,
  myId,
  nameOf,
  openChat,
  partner,
  pending,
  showToast,
  toggleReaction,
  typingIn,
} from '../lib/store';
import { ChatAvatar, chatName, readByOthers } from './ChatList';
import { startCall } from '../lib/call';
import { callLabel } from './Call';
import { Composer, type ComposerHandle } from './Composer';
import { FileChip, VideoClip, VideoNote, VoicePlayer } from './Media';
import { EmojiPicker } from './EmojiPicker';
import { approving, colorOf, EncImage, Icon, IconButton, lightbox, Modal } from './ui';

const QUICK = ['❤️', '👍', '😂', '😮', '😢', '🔥', '🙏', '👎'];

export function statusLine(c: Chat): { text: string; accent: boolean } {
  const typers = typingIn(c.id);
  if (typers.length)
    return {
      text: c.kind === 'group' ? t('chat.typingName', { name: nameOf(c.id, typers[0]) }) : t('chat.typing'),
      accent: true,
    };
  if (c.kind === 'group') return { text: t('chat.members', { n: c.members.length }), accent: false };
  const p = partner(c);
  if (!p) return { text: '', accent: false };
  if (p.online) return { text: t('chat.online'), accent: true };
  return { text: p.last_seen ? fmtLastSeen(p.last_seen) : t('chat.recently'), accent: false };
}

interface MenuState {
  m: Msg;
  x: number;
  y: number;
}

export function ChatView(props: { id: number }) {
  const c = findChat(props.id);
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [forwarding, setForwarding] = useState<Msg | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [hit, setHit] = useState(0);
  const [digging, setDigging] = useState(false);
  const [trust, setTrust] = useState<Trust>('none');
  const composer = useRef<ComposerHandle>(null);
  const stick = useRef<() => void>(() => {});

  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
    setSearch(null);
    openChat(props.id).catch((e) => showToast(errText(e)));
  }, [props.id]);

  // Esc closes the chat profile, then the chat itself, unless something on
  // top claims it first: a reply or an edit (the composer prevents the
  // default), search, a menu, the emoji panel or a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open], .menu-layer, .emoji-picker')) return;
      replace(route.value.name === 'info' ? `c/${props.id}` : '');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.id]);

  // A verified partner whose devices changed since gets a visible warning.
  const partnerId = c && partner(c)?.id;
  useEffect(() => {
    setTrust('none');
    if (partnerId) trustOf(props.id, partnerId).then(setTrust, () => {});
  }, [props.id, partnerId, devicesTick.value, peerTick.value]);

  // Search runs on the device (the server only has ciphertext): newest
  // hits first, older history pulled in the background.
  const q = (search ?? '').trim().toLowerCase();
  const hits = q
    ? (messages.value.get(props.id) ?? [])
        .filter((m) => !m.deleted && searchable(m).includes(q))
        .map((m) => m.id)
        .reverse()
    : [];
  useEffect(() => {
    setHit(0);
    if (hits[0]) jumpTo(props.id, hits[0]);
  }, [q]);
  const step = (d: number) => {
    const next = Math.max(0, Math.min(hits.length - 1, hit + d));
    setHit(next);
    if (hits[next]) jumpTo(props.id, hits[next]);
  };
  const openSearch = () => {
    setSearch('');
    setDigging(true);
    loadHistory(props.id).finally(() => setDigging(false));
  };

  if (!c) return <div class="main-empty" />;
  const loadedList = messages.value.get(c.id);
  const list = (loadedList ?? []).filter((m) => !m.deleted);
  const status = statusLine(c);
  const recovery = pending.value.filter((p) => !p.own && c.needs_key?.includes(p.id));
  const alone = c.kind === 'direct' && c.members.length < 2;

  const editLast = () => {
    const mine = [...list].reverse().find((m) => m.user === myId() && !m.local && m.p);
    if (mine) setEditing(mine);
  };

  return (
    <section
      class={'chat' + (dragging ? ' dragging' : '')}
      aria-label={chatName(c)}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles([...(e.dataTransfer?.files ?? [])]);
      }}
    >
      <header class="bar chat-bar">
        <IconButton icon="back" label={t('common.back')} class="only-narrow" onClick={() => back()} />
        {search !== null ? (
          <div class="search-bar" role="search">
            <input
              class="search"
              autoFocus
              value={search}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') {
                  e.preventDefault(); // closes the search, not the chat
                  setSearch(null);
                }
              }}
            />
            <span class="search-count" aria-live="polite">
              {hits.length ? `${hit + 1} / ${hits.length}` : q ? t('search.none') : digging ? t('search.loading') : ''}
            </span>
            <IconButton icon="up" label={t('search.older')} disabled={hit >= hits.length - 1} onClick={() => step(1)} />
            <IconButton icon="down" label={t('search.newer')} disabled={hit <= 0} onClick={() => step(-1)} />
            <IconButton icon="close" label={t('common.close')} onClick={() => setSearch(null)} />
          </div>
        ) : (
        <button class="chat-bar-who" onClick={() => go(`c/${c.id}/info`)} aria-label={t('chat.info')}>
          <ChatAvatar c={c} size={40} />
          <span class="chat-bar-text">
            <b>{chatName(c)}</b>
            <small class={status.accent ? 'accent' : ''} aria-live="polite">
              {status.text}
            </small>
          </span>
        </button>
        )}
        {search === null && c.kind === 'direct' && partner(c) && (
          <>
            <IconButton icon="phone" label={t('call.audio')} onClick={() => startCall(c.id, partner(c)!.id, false)} />
            <IconButton icon="videocam" label={t('call.video')} onClick={() => startCall(c.id, partner(c)!.id, true)} />
          </>
        )}
        {search === null && <IconButton icon="search" label={t('search.open')} onClick={openSearch} />}
      </header>
      {c.pinnedMsg && search === null && (
        <div class="pin-bar">
          <button type="button" class="pin-bar-main" onClick={() => jumpTo(c.id, c.pinnedMsg!.id)}>
            <Icon name="pin" />
            <span>
              <b>{t('pin.title')}</b>
              <small>{summary(c.pinnedMsg.p) || t('list.locked')}</small>
            </span>
          </button>
          <IconButton icon="close" label={t('chat.unpin')} onClick={() => pinMessage(c.id, 0).catch((e) => showToast(errText(e)))} />
        </div>
      )}

      {recovery.map((p) => (
        <div key={p.id} class="banner warn">
          <Icon name="devices" />
          <span>{t('chat.recovery', { name: p.name })}</span>
          <button class="btn small" onClick={() => (approving.value = p)}>
            {t('chat.check')}
          </button>
        </div>
      ))}
      {trust === 'changed' && (
        <div class="banner warn" role="alert">
          <Icon name="alert" />
          <span>{t('safety.banner', { name: chatName(c) })}</span>
          <button class="btn small" onClick={() => go(`c/${c.id}/info`)}>
            {t('safety.check')}
          </button>
        </div>
      )}
      {alone && (
        <div class="banner">
          <span>{t('chat.alone')}</span>
          <button class="btn small" onClick={() => go(`c/${c.id}/info`)}>
            {t('chat.inviteAgain')}
          </button>
        </div>
      )}

      <MessageList
        key={c.id}
        chat={c}
        list={list}
        loading={!loadedList}
        highlight={hits[hit]}
        onMenu={setMenu}
        onReply={setReplyTo}
        stick={stick}
      />

      <Composer
        key={c.id}
        chat={c}
        replyTo={replyTo}
        editing={editing}
        onCancel={() => {
          setReplyTo(null);
          setEditing(null);
        }}
        onSent={() => stick.current()}
        onEditLast={editLast}
        handle={composer}
      />

      {menu && (
        <MessageMenu
          chat={c}
          state={menu}
          onClose={() => setMenu(null)}
          onReply={() => {
            setReplyTo(menu.m);
            composer.current?.focus();
          }}
          onEdit={() => {
            setEditing(menu.m);
            composer.current?.focus();
          }}
          onForward={() => setForwarding(menu.m)}
        />
      )}
      {forwarding && <ForwardDialog m={forwarding} onClose={() => setForwarding(null)} />}
    </section>
  );
}

function MessageList(props: {
  chat: Chat;
  list: Msg[];
  loading: boolean;
  highlight?: number;
  onMenu: (s: MenuState) => void;
  onReply: (m: Msg) => void;
  stick: { current: () => void };
}) {
  const { chat, list } = props;
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevFirst = useRef(0);
  const prevHeight = useRef(0);
  const [down, setDown] = useState(false);
  // Where reading stopped when the chat was opened (before marking read).
  const readAtOpen = useRef(chat.members.find((m) => m.id === myId())?.last_read ?? 0);
  const firstUnread = useRef<number | null | undefined>(undefined);
  if (firstUnread.current === undefined && !props.loading) {
    firstUnread.current = list.find((m) => m.id > readAtOpen.current && m.user !== myId() && !m.local)?.id ?? null;
  }

  props.stick.current = () => {
    atBottom.current = true;
  };

  useLayoutEffect(() => {
    const el = ref.current!;
    const first = list[0]?.id ?? 0;
    if (!prevFirst.current && first && firstUnread.current) {
      // First paint with unread messages: start at the "unread" mark.
      document.getElementById('unread-mark')?.scrollIntoView({ block: 'start' });
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    } else if (prevFirst.current && first < prevFirst.current) {
      // Older page prepended: keep what the reader was looking at in place.
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
    if (atBottom.current && !props.loading) markRead(chat.id);
  }, [list]);

  function onScroll() {
    const el = ref.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setDown(!atBottom.current);
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < 400 && hasOlder.value.get(chat.id)) loadOlder(chat.id);
    if (atBottom.current) markRead(chat.id);
  }

  const toBottom = () => {
    const el = ref.current!;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  const items = [];
  let prev: Msg | undefined;
  for (const m of list) {
    if (!prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString()) {
      items.push(
        <div key={'d' + m.id} class="day" role="separator">
          <span>{fmtDay(m.at)}</span>
        </div>,
      );
    }
    if (m.id === firstUnread.current) {
      items.push(
        <div key="unread" id="unread-mark" class="day unread-mark" role="separator">
          <span>{t('chat.unreadMark')}</span>
        </div>,
      );
    }
    const firstOfRun = !prev || prev.user !== m.user || m.at - prev.at > 5 * 60e3;
    items.push(
      <Bubble key={m.cid || m.id} m={m} chat={chat} showName={firstOfRun} hit={m.id === props.highlight} onMenu={props.onMenu} onReply={props.onReply} />,
    );
    prev = m;
  }

  return (
    <div class="messages" ref={ref} onScroll={onScroll}>
      <div class="messages-col" role="log" aria-label={t('chat.messages')} aria-live="polite">
        {list.length === 0 && !props.loading && (
          <div class="day">
            <span>{t('chat.empty')}</span>
          </div>
        )}
        {items}
      </div>
      {down && (
        <button class="to-bottom" aria-label={t('chat.toBottom')} title={t('chat.toBottom')} onClick={toBottom}>
          <Icon name="down" />
          {chat.unread > 0 && <span class="badge">{chat.unread}</span>}
        </button>
      )}
    </div>
  );
}

const searchable = (m: Msg) => ((m.p?.t ?? '') + ' ' + (m.p?.a ?? []).map((a) => a.n ?? '').join(' ')).toLowerCase();

// jumpTo brings a message into view, paging back through history first.
async function jumpTo(chatId: number, id: number) {
  if (await ensureLoaded(chatId, id)) requestAnimationFrame(() => scrollToMessage(id));
  else showToast(t('chat.notFound'));
}

function scrollToMessage(id: number) {
  const el = document.getElementById('m' + id);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

function Bubble(props: {
  m: Msg;
  chat: Chat;
  showName: boolean;
  hit?: boolean;
  onMenu: (s: MenuState) => void;
  onReply: (m: Msg) => void;
}) {
  const { m, chat } = props;
  const mine = m.user === myId();
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const opened = useRef(false);
  const swipe = useRef(0); // px pulled left, for swipe-to-reply on touch
  const row = useRef<HTMLDivElement>(null);
  const SWIPE_AT = 64;
  const pull = (dx: number) => {
    swipe.current = dx;
    const el = row.current;
    if (!el) return;
    el.classList.add('swiping');
    el.classList.toggle('settling', !dx); // follow the finger, ease back on release
    el.style.setProperty('--dx', `${dx}px`);
    el.style.setProperty('--swipe', String(Math.min(1, -dx / SWIPE_AT)));
    if (!dx) setTimeout(() => !swipe.current && el.classList.remove('swiping', 'settling'), 200);
  };
  // Only a finger lifted past the threshold replies; a cancelled gesture
  // (the browser took over to scroll) just springs back.
  const release = (commit: boolean) => {
    clearTimeout(press.current);
    start.current = null;
    if (commit && swipe.current <= -SWIPE_AT) {
      navigator.vibrate?.(10);
      props.onReply(m);
    }
    if (swipe.current) pull(0);
  };

  const open = (x: number, y: number) => {
    opened.current = true;
    props.onMenu({ m, x, y });
  };

  const atts = m.p?.a ?? [];
  const photos = atts.filter((a) => !a.t);
  const others = atts.filter((a) => a.t);
  const localPhotos = (m.files ?? []).filter((f) => f.kind === 'image');
  const localOthers = (m.files ?? []).filter((f) => f.kind !== 'image');
  const hasPhotos = photos.length > 0 || localPhotos.length > 0;
  const hasMedia = hasPhotos || atts.some((a) => a.t === 'clip') || localOthers.some((f) => f.kind === 'clip');
  // One to three emoji and nothing else are drawn large, without a bubble.
  const big = !atts.length && !m.files?.length && !m.p?.rp && !m.p?.fw && m.p?.t ? jumbo(m.p.t) : 0;
  // A lone video circle is drawn without a bubble, like in Telegram.
  const circleOnly =
    !m.p?.t && !m.p?.rp && atts.length + (m.files?.length ?? 0) === 1 && (atts[0]?.t ?? m.files?.[0]?.kind) === 'video';
  const status = m.local === 'failed' ? 'alert' : m.local ? 'clock' : readByOthers(chat, m.id) ? 'checks' : 'check';
  const statusLabel =
    m.local === 'failed' ? t('chat.failed') : m.local ? t('chat.sending') : status === 'checks' ? t('chat.read') : t('chat.sent');
  const author = mine ? t('list.you') : nameOf(chat.id, m.user);
  // Inside the text so it floats into the last line, Telegram style.
  const meta = (
    <span class="meta">
      {m.bad && m.p && (
        <span class="bad" title={t('chat.badSig')} aria-label={t('chat.badSig')}>
          <Icon name="alert" size={14} />
        </span>
      )}
      {m.edited ? <span>{t('chat.edited')}</span> : null}
      <time dateTime={new Date(m.at).toISOString()}>{fmtTime(m.at)}</time>
      {mine && (
        <span class={'tick ' + status} aria-label={statusLabel} title={statusLabel}>
          <Icon name={status} size={16} />
        </span>
      )}
    </span>
  );

  return (
    <div
      id={'m' + m.id}
      ref={row}
      class={
        'msg ' +
        (mine ? 'mine' : 'theirs') +
        (hasMedia ? ' has-media' : '') +
        (circleOnly ? ' circle-only' : '') +
        (big ? ' jumbo j' + big : '') +
        (props.hit ? ' hit' : '')
      }
      tabIndex={0}
      aria-label={`${author}, ${fmtTime(m.at)}`}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!opened.current) open(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        opened.current = false;
        if (e.pointerType !== 'touch') return;
        start.current = { x: e.clientX, y: e.clientY };
        // iOS Safari has no contextmenu on long-press: time it ourselves.
        press.current = setTimeout(() => open(e.clientX, e.clientY), 450);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        const dy = e.clientY - start.current.y;
        if (Math.hypot(dx, dy) > 10) clearTimeout(press.current);
        // Leftward and mostly horizontal: the row follows the finger.
        if (!m.local && !opened.current && (swipe.current || (dx < -10 && Math.abs(dx) > 2 * Math.abs(dy)))) pull(Math.max(Math.min(dx, 0), -96));
      }}
      onPointerUp={() => release(true)}
      onPointerCancel={() => release(false)}
      onDblClick={() => !m.local && props.onReply(m)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          open(r.left + r.width / 2, r.top + r.height / 2);
        }
      }}
      onClick={() => m.local === 'failed' && m.retry?.()}
    >
      <div class="bubble">
        {chat.kind === 'group' && !mine && props.showName && (
          <b class="author" style={{ color: colorOf(m.user) }}>
            {author}
          </b>
        )}
        {m.p?.fw && (
          <span class="forwarded">
            <Icon name="forward" size={14} /> {t('fw.from', { name: m.p.fw.n })}
          </span>
        )}
        {m.p?.rp && (
          <button type="button" class="reply-quote" onClick={(e) => (e.stopPropagation(), jumpTo(chat.id, m.p!.rp!.id))}>
            <b>{m.p.rp.n}</b>
            <span>{m.p.rp.t}</span>
          </button>
        )}
        {hasPhotos && (
          <div class={'gallery n' + Math.min(photos.length || localPhotos.length, 4)}>
            {photos.length
              ? photos.map((a) => <EncImage key={a.id} a={a} fill={photos.length > 1} onOpen={() => (lightbox.value = a)} />)
              : localPhotos.map((f) => (
                  <span class="img fill uploading">
                    <img src={f.url} alt="" class="full" />
                  </span>
                ))}
          </div>
        )}
        {others.map((a) =>
          a.t === 'voice' ? (
            <VoicePlayer key={a.id} a={a} />
          ) : a.t === 'video' ? (
            <VideoNote key={a.id} a={a} />
          ) : a.t === 'clip' ? (
            <VideoClip key={a.id} a={a} />
          ) : (
            <FileChip key={a.id} a={a} />
          ),
        )}
        {localOthers.map((f) =>
          f.kind === 'clip' ? (
            <span class="clip uploading">
              <video src={f.url} muted playsInline preload="metadata" />
            </span>
          ) : f.kind === 'video' ? (
            <span class="circle-note uploading">
              <video src={f.url} muted playsInline preload="metadata" />
            </span>
          ) : (
            <span class="file-chip uploading">
              <span class="file-icon">
                <Icon name={f.kind === 'voice' ? 'mic' : 'file'} />
              </span>
              <span class="file-text">
                <b>{f.kind === 'voice' ? t('att.voice') : f.name}</b>
                <small>{f.kind === 'voice' ? fmtDuration(f.d ?? 0) : t('chat.sending')}</small>
              </span>
            </span>
          ),
        )}
        {m.p?.cl ? (
          <span class="call-log">
            <Icon name={m.p.cl.v ? 'videocam' : 'phone'} size={18} />
            <span>{callLabel(m.p.cl, mine)}</span>
            {meta}
          </span>
        ) : m.p === null ? (
          <i class="locked">
            <Icon name="lock" size={16} /> {t('chat.locked')} {meta}
          </i>
        ) : m.p?.t ? (
          <div class="text">
            <Markup text={m.p.t} />
            {m.p.lp && <LinkCardView lp={m.p.lp} />}
            {meta}
          </div>
        ) : (
          meta
        )}
      </div>
      {m.rx && m.rx.length > 0 && (
        <div class="reactions">
          {m.rx.map(([emoji, users]) => (
            <button
              type="button"
              class={'chip' + (users.includes(myId()) ? ' on' : '')}
              aria-pressed={users.includes(myId())}
              title={users.map((u) => (u === myId() ? t('list.you') : nameOf(chat.id, u))).join(', ')}
              onClick={(e) => {
                e.stopPropagation();
                toggleReaction(m, emoji).catch((err) => showToast(errText(err)));
              }}
            >
              {emoji} {users.length > 1 && <span>{users.length}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// LinkCardView draws a preview the sender built. It came from another
// member, so only an http(s) link and an inline picture are accepted.
function LinkCardView(props: { lp: LinkCard }) {
  const { lp } = props;
  if (!/^https?:\/\//i.test(lp.u)) return null;
  const img = lp.i?.startsWith('data:image/') ? lp.i : undefined;
  return (
    <a class="link-card" href={lp.u} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      {lp.s && <small>{lp.s}</small>}
      {lp.t && <b>{lp.t}</b>}
      {lp.d && <span>{lp.d}</span>}
      {img && <img src={img} alt="" />}
    </a>
  );
}

function MessageMenu(props: {
  chat: Chat;
  state: MenuState;
  onClose: () => void;
  onReply: () => void;
  onEdit: () => void;
  onForward: () => void;
}) {
  const { chat, state, onClose } = props;
  const { m } = state;
  const mine = m.user === myId();
  const [picker, setPicker] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);

  const act = (fn: () => unknown) => () => {
    onClose();
    Promise.resolve(fn()).catch((e) => showToast(errText(e)));
  };
  const react = (e: string) => act(() => toggleReaction(m, e))();

  const canReact = !m.local && m.p;
  const canEdit = mine && !m.local && !!m.p;
  const canDelete = mine || chat.kind === 'direct' || chat.created_by === myId();
  const text = m.p?.t?.replace(/\*\*|__|~~|`/g, '');

  const w = 260;
  const left = Math.max(8, Math.min(state.x, innerWidth - w - 8));
  const top = Math.max(8, Math.min(state.y, innerHeight - (picker ? 380 : 300)));

  return (
    <div class="menu-layer" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="menu" role="menu" ref={ref} style={{ left: `${left}px`, top: `${top}px`, width: `${w}px` }}>
        {canReact && !picker && (
          <div class="menu-reactions">
            {QUICK.map((e) => (
              <button type="button" role="menuitem" aria-label={e} onClick={() => react(e)}>
                {e}
              </button>
            ))}
            <button type="button" role="menuitem" aria-label={t('chat.more')} onClick={() => setPicker(true)}>
              <Icon name="plus" size={20} />
            </button>
          </div>
        )}
        {picker ? (
          <EmojiPicker onPick={react} onClose={() => setPicker(false)} />
        ) : (
          <>
            {!m.local && (
              <button type="button" role="menuitem" onClick={act(props.onReply)}>
                <Icon name="reply" /> {t('chat.reply')}
              </button>
            )}
            {!m.local && m.p && (
              <button type="button" role="menuitem" onClick={act(props.onForward)}>
                <Icon name="forward" /> {t('chat.forward')}
              </button>
            )}
            {!m.local && (
              <button type="button" role="menuitem" onClick={act(() => pinMessage(chat.id, chat.pinned === m.id ? 0 : m.id))}>
                <Icon name="pin" /> {chat.pinned === m.id ? t('chat.unpin') : t('chat.pin')}
              </button>
            )}
            {text && (
              <button type="button" role="menuitem" onClick={act(() => navigator.clipboard?.writeText(text))}>
                <Icon name="copy" /> {t('common.copy')}
              </button>
            )}
            {canEdit && (
              <button type="button" role="menuitem" onClick={act(props.onEdit)}>
                <Icon name="edit" /> {t('chat.edit')}
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                role="menuitem"
                class="danger"
                onClick={act(() => (m.local || confirm(t('chat.deleteConfirm'))) && deleteMessage(m))}
              >
                <Icon name="trash" /> {t('chat.delete')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ForwardDialog(props: { m: Msg; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const list = [...chats.value].sort((a, b) => (b.lastMsg?.at ?? b.created_at) - (a.lastMsg?.at ?? a.created_at));
  const send = async (to: number) => {
    setBusy(true);
    try {
      await forwardMessage(props.m, to);
      props.onClose();
      showToast(t('fw.done'));
      goChat(to);
    } catch (e) {
      showToast(errText(e));
      setBusy(false);
    }
  };
  return (
    <Modal label={t('fw.title')} onClose={props.onClose}>
      <h2>{t('fw.title')}</h2>
      <ul class="rows forward-list">
        {list.map((c) => (
          <li key={c.id}>
            <button type="button" class="row action plain" disabled={busy} onClick={() => send(c.id)}>
              <ChatAvatar c={c} size={40} />
              <span>{chatName(c)}</span>
            </button>
          </li>
        ))}
      </ul>
      <button class="btn secondary" onClick={props.onClose}>
        {t('common.cancel')}
      </button>
    </Modal>
  );
}

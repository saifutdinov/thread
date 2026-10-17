import { useState } from 'preact/hooks';
import { fmtListTime, t } from '../lib/i18n';
import { enablePush, notifPermission, pushSupported } from '../lib/pwa';
import { go, route } from '../lib/route';
import { type Chat, chatPicture, chats, goChat, myId, nameOf, offline, partner, pending, summary, typingIn } from '../lib/store';
import { approving, Avatar, Icon, IconButton } from './ui';

export function chatName(c: Chat): string {
  if (c.kind === 'group') return c.titleText || t('list.group');
  return partner(c)?.name ?? t('list.waiting');
}

// ChatAvatar: a group's photo, or the partner's avatar in a direct chat.
export function ChatAvatar(props: { c: Chat; size?: number; online?: boolean }) {
  const { c } = props;
  const p = partner(c);
  return (
    <Avatar
      id={c.kind === 'group' ? -c.id : (p?.id ?? -c.id)}
      name={c.kind === 'group' ? c.titleText : (p?.name ?? '')}
      group={c.kind === 'group'}
      size={props.size}
      online={props.online}
      src={chatPicture(c)}
    />
  );
}

export function preview(c: Chat): string {
  const m = c.lastMsg;
  if (!m) return c.kind === 'direct' && c.members.length < 2 ? t('list.waiting') : '';
  if (m.p === null) return '🔒 ' + t('list.locked');
  const body = summary(m.p);
  if (m.user === myId()) return c.kind === 'group' ? `${t('list.you')}: ${body}` : body;
  return c.kind === 'group' ? `${nameOf(c.id, m.user)}: ${body}` : body;
}

// readByOthers: has anyone else read up to this message (✓✓)?
export const readByOthers = (c: Chat, id: number) => c.members.some((m) => m.id !== myId() && m.last_read >= id);

const recency = (c: Chat) => c.lastMsg?.at ?? c.created_at;

function dismissedRecently(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem('notifBanner') ?? 0) < 7 * 864e5;
  } catch {
    return false;
  }
}

function NotifBanner() {
  const [hidden, setHidden] = useState(dismissedRecently());
  if (hidden || !pushSupported || notifPermission.value !== 'default') return null;
  return (
    <div class="banner" role="region" aria-label={t('settings.notifications')}>
      <Icon name="bell" />
      <span>{t('list.notifBanner')}</span>
      <button class="btn small" onClick={() => enablePush().then(() => setHidden(true))}>
        {t('list.notifAction')}
      </button>
      <IconButton
        icon="close"
        label={t('common.later')}
        onClick={() => {
          try {
            localStorage.setItem('notifBanner', String(Date.now()));
          } catch {
            /* fine: it just shows again */
          }
          setHidden(true);
        }}
      />
    </div>
  );
}

export function ChatList() {
  const [q, setQ] = useState('');
  const active = route.value.name === 'chat' || route.value.name === 'info' ? route.value.id : undefined;
  const needle = q.trim().toLowerCase();
  const list = [...chats.value]
    .sort((a, b) => recency(b) - recency(a))
    .filter((c) => !needle || chatName(c).toLowerCase().includes(needle));
  const own = pending.value.filter((p) => p.own);

  return (
    <nav class="sidebar-body" aria-label={t('list.chats')}>
      <header class="bar">
        <IconButton icon="menu" label={t('list.settings')} onClick={() => go('settings')} />
        <input
          type="search"
          class="search"
          placeholder={t('list.search')}
          aria-label={t('list.search')}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
      </header>
      {offline.value && (
        <div class="status-line" role="status">
          {t('list.connecting')}
        </div>
      )}
      {own.map((p) => (
        <button key={p.id} class="banner warn" onClick={() => (approving.value = p)}>
          <Icon name="devices" />
          <span>
            {t('approve.own')}: {p.label}
          </span>
        </button>
      ))}
      <NotifBanner />
      {list.length ? (
        <ul class="chat-list">
          {list.map((c) => {
            const name = chatName(c);
            const p = partner(c);
            const typers = typingIn(c.id);
            const mine = c.lastMsg && c.lastMsg.user === myId();
            const read = mine && readByOthers(c, c.lastMsg!.id);
            return (
              <li key={c.id}>
                <button
                  class="chat-item"
                  aria-current={active === c.id ? 'page' : undefined}
                  onClick={() => goChat(c.id)}
                  aria-label={[name, c.unread ? t('list.unread', { n: c.unread }) : ''].filter(Boolean).join(', ')}
                >
                  <ChatAvatar c={c} online={p?.online} />
                  <span class="chat-item-body">
                    <span class="chat-item-top">
                      <span class="chat-item-name">
                        {c.kind === 'group' && <Icon name="group" size={16} />} {name}
                      </span>
                      {mine && <span class="tick" aria-label={read ? t('chat.read') : t('chat.sent')}><Icon name={read ? 'checks' : 'check'} size={16} /></span>}
                      <time class="chat-item-time">{fmtListTime(c.lastMsg?.at ?? c.created_at)}</time>
                    </span>
                    <span class="chat-item-bottom">
                      <span class={'chat-item-preview' + (typers.length ? ' accent' : '')}>
                        {typers.length
                          ? c.kind === 'group'
                            ? t('chat.typingName', { name: nameOf(c.id, typers[0]) })
                            : t('chat.typing')
                          : preview(c)}
                      </span>
                      {c.unread > 0 && <span class="badge">{c.unread > 999 ? '999+' : c.unread}</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="list-empty">{needle ? t('list.nothing') : t('list.empty')}</p>
      )}
      <button class="fab" aria-label={t('list.new')} title={t('list.new')} onClick={() => go('new')}>
        <Icon name="edit" />
      </button>
    </nav>
  );
}

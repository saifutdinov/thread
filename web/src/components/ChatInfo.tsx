import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { errText, fmtDate, fmtLastSeen, t } from '../lib/i18n';
import { back } from '../lib/route';
import {
  type Attachment,
  clearHistory,
  createRecoveryLink,
  findChat,
  inviteToChat,
  leaveChat,
  mediaMessages,
  type Msg,
  myId,
  picture,
  setGroupPhoto,
  showToast,
} from '../lib/store';
import { ChatAvatar, chatName } from './ChatList';
import { statusLine } from './ChatView';
import { LinkView } from './NewChat';
import { FileChip, VideoNote, VoicePlayer } from './Media';
import { SafetyPanel } from './Security';
import { Avatar, EncImage, Icon, lightbox, Modal, Panel, PictureButtons } from './ui';

type Invite = { id: string; max_uses: number; uses: number; expires_at: number };

export function ChatInfo(props: { id: number }) {
  const c = findChat(props.id);
  const [media, setMedia] = useState<Msg[]>([]);
  const [moreMedia, setMoreMedia] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [link, setLink] = useState('');
  const [rescue, setRescue] = useState<{ name: string; link: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [codeFor, setCodeFor] = useState<{ id: number; name: string } | null>(null);

  const loadInvites = () => api.invites(props.id).then(setInvites, () => {});
  useEffect(() => {
    mediaMessages(props.id).then((list) => {
      setMedia(list);
      setMoreMedia(list.length === 50);
    }, () => {});
    loadInvites();
  }, [props.id]);

  if (!c) return null;
  const isCreator = c.created_by === myId();
  const canInvite = c.kind === 'group' || c.members.length < 2;
  const canClear = c.kind === 'direct' || isCreator;
  const status = statusLine(c);
  const all: Attachment[] = media.flatMap((m) => m.p?.a ?? []);
  const photos = all.filter((a) => !a.t);
  const files = all.filter((a) => a.t === 'file');
  const voices = all.filter((a) => a.t === 'voice' || a.t === 'video');

  async function invite() {
    setBusy(true);
    try {
      setLink(await inviteToChat(c!.id, 1));
      loadInvites();
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function recover(m: { id: number; name: string }) {
    setBusy(true);
    try {
      setRescue({ name: m.name, link: await createRecoveryLink(m.id) });
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const guard = (fn: () => Promise<unknown>, question: string) => async () => {
    if (!confirm(question)) return;
    try {
      await fn();
    } catch (e) {
      showToast(errText(e));
    }
  };

  return (
    <Panel title={t('chat.info')} onBack={() => back(`c/${c.id}`)} class="info">
      <div class="profile-head">
        <ChatAvatar c={c} size={96} />
        {c.kind === 'group' && <PictureButtons has={!!c.photo_v} onSet={(f) => setGroupPhoto(c, f)} />}
        <h2>{chatName(c)}</h2>
        <p class={status.accent ? 'accent' : 'muted'}>{status.text}</p>
        <p class="muted small with-icon">
          <Icon name="lock" size={14} /> {t('info.encrypted')}
        </p>
      </div>

      {link ? (
        <section class="card">
          <LinkView link={link} uses={1} onOpen={() => setLink('')} />
        </section>
      ) : (
        canInvite && (
          <button class="row action" disabled={busy} onClick={invite}>
            <Icon name="link" /> {t('info.invite')}
          </button>
        )
      )}

      {rescue ? (
        <section class="card">
          <LinkView
            link={rescue.link}
            uses={1}
            onOpen={() => setRescue(null)}
            copy={{ title: t('recovery.title'), text: t('recovery.text', { name: rescue.name }), note: t('recovery.note') }}
          />
        </section>
      ) : (
        c.members
          .filter((m) => m.invitee)
          .map((m) => (
            <button key={m.id} class="row action" disabled={busy} onClick={() => recover(m)}>
              <Icon name="lock" /> {t('info.recover', { name: m.name })}
            </button>
          ))
      )}

      {c.kind === 'direct' && c.members.find((m) => m.id !== myId()) && (
        <section class="card">
          <h3>{t('safety.title')}</h3>
          <SafetyPanel
            chatId={c.id}
            userId={c.members.find((m) => m.id !== myId())!.id}
            name={c.members.find((m) => m.id !== myId())!.name}
          />
        </section>
      )}

      {invites.length > 0 && (
        <section class="card">
          <h3>{t('info.invites')}</h3>
          <ul class="rows">
            {invites.map((i) => (
              <li class="row" key={i.id}>
                <span class="row-text">
                  <small>{t('info.uses', { uses: i.uses, max: i.max_uses, date: fmtDate(i.expires_at) })}</small>
                </span>
                <button
                  class="btn small secondary"
                  onClick={() => api.deleteInvite(i.id).then(loadInvites, (e) => showToast(errText(e)))}
                >
                  {t('info.revoke')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {c.kind === 'group' && (
        <section class="card">
          <h3>
            {t('info.members')} · {c.members.length}
          </h3>
          <ul class="rows">
            {c.members.map((m) => (
              <li class="row" key={m.id}>
                <Avatar id={m.id} name={m.name} size={40} online={m.online} src={picture(c.id, m.id, m.avatar_v)} />
                <span class="row-text">
                  <span>
                    {m.name} {m.id === myId() && <small class="muted">({t('info.you')})</small>}
                  </span>
                  <small class={m.online ? 'accent' : 'muted'}>
                    {m.online ? t('chat.online') : m.last_seen ? fmtLastSeen(m.last_seen) : t('chat.recently')}
                  </small>
                </span>
                {m.id !== myId() && (
                  <button class="btn small secondary" onClick={() => setCodeFor({ id: m.id, name: m.name })}>
                    {t('safety.code')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="card">
        <h3>{t('info.media')}</h3>
        {photos.length > 0 && (
          <div class="media-grid">
            {photos.map((a) => (
              <EncImage key={a.id} a={a} fill onOpen={() => (lightbox.value = a)} />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <>
            <h4>{t('info.files')}</h4>
            <div class="stack">
              {files.map((a) => (
                <FileChip key={a.id} a={a} />
              ))}
            </div>
          </>
        )}
        {voices.length > 0 && (
          <>
            <h4>{t('info.voices')}</h4>
            <div class="stack">
              {voices.map((a) => (a.t === 'voice' ? <VoicePlayer key={a.id} a={a} /> : <VideoNote key={a.id} a={a} />))}
            </div>
          </>
        )}
        {all.length === 0 && <p class="muted">{t('info.noMedia')}</p>}
        {moreMedia && (
          <button
            class="btn secondary small"
            onClick={() =>
              mediaMessages(props.id, media[media.length - 1].id).then((list) => {
                setMedia([...media, ...list]);
                setMoreMedia(list.length === 50);
              })
            }
          >
            …
          </button>
        )}
      </section>

      <section class="card">
        {canClear && (
          <button
            class="row action danger"
            onClick={guard(async () => {
              await clearHistory(c.id);
              setMedia([]);
            }, t('info.clearConfirm'))}
          >
            <Icon name="trash" /> {t('info.clear')}
          </button>
        )}
        <button
          class="row action danger"
          onClick={guard(() => leaveChat(c.id), t('info.leaveConfirm'))}
        >
          <Icon name="logout" /> {t('info.leave')}
        </button>
      </section>
      {codeFor && (
        <Modal label={t('safety.title')} onClose={() => setCodeFor(null)}>
          <h2>
            {t('safety.title')}: {codeFor.name}
          </h2>
          <SafetyPanel chatId={c.id} userId={codeFor.id} name={codeFor.name} />
          <button class="btn secondary" onClick={() => setCodeFor(null)}>
            {t('common.close')}
          </button>
        </Modal>
      )}
    </Panel>
  );
}

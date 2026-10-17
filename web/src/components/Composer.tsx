import { useEffect, useImperativeHandle, useRef, useState } from 'preact/hooks';
import type { Ref } from 'preact';
import { errText, t } from '../lib/i18n';
import { firstLink } from '../lib/markup';
import { linkPreviews } from '../lib/prefs';
import { canRecord, fmtDuration, fmtSize, openStream, type Recording, startRecording, VOICE_MAX_MS } from '../lib/recorder';
import {
  type Chat,
  editMessage,
  type LinkCard,
  linkCard,
  MAX_FILE,
  type Msg,
  myId,
  nameOf,
  type Outgoing,
  sendMessage,
  sendTyping,
  showToast,
  summary,
} from '../lib/store';
import { EmojiPicker } from './EmojiPicker';
import { CircleRecorder } from './Media';
import { Icon, IconButton } from './ui';

const MAX_LEN = 4096;
const MAX_FILES = 10;
const drafts = new Map<number, string>();
const coarse = matchMedia('(pointer: coarse)');

export interface ComposerHandle {
  addFiles(files: File[]): void;
  focus(): void;
}

export function Composer(props: {
  chat: Chat;
  replyTo: Msg | null;
  editing: Msg | null;
  onCancel: () => void;
  onSent: () => void;
  onEditLast: () => void;
  handle: Ref<ComposerHandle>;
}) {
  const { chat, replyTo, editing } = props;
  const [text, setText] = useState(drafts.get(chat.id) ?? '');
  const [files, setFiles] = useState<{ kind: 'image' | 'clip' | 'file'; file: File; url: string }[]>([]);
  const [emoji, setEmoji] = useState(false);
  const [hasSel, setHasSel] = useState(false);
  const [menu, setMenu] = useState(false);
  const [circle, setCircle] = useState(false);
  // Link preview for the first link in the text (opt-in, see prefs).
  const [card, setCard] = useState<{ from: string; lp: LinkCard } | null>(null);
  const [noCard, setNoCard] = useState(''); // a link whose card was closed
  const textNow = useRef(text);
  textNow.current = text;
  const [rec, setRec] = useState<Recording | null>(null);
  const [recMs, setRecMs] = useState(0);
  const [recLevel, setRecLevel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Pictures go out as photos, videos as playable clips; anything else (or
  // a forced "file") as a file.
  const addFiles = (list: File[], asFile = false) => {
    const big = list.find((f) => f.size > MAX_FILE);
    if (big) showToast(`${t('err.too_large')} ${big.name}: ${fmtSize(big.size)}`);
    const ok = list.filter((f) => f.size <= MAX_FILE);
    setFiles((cur) =>
      [
        ...cur,
        ...ok.map((file) => ({
          kind: asFile ? ('file' as const) : file.type.startsWith('image/') ? ('image' as const) : file.type.startsWith('video/') ? ('clip' as const) : ('file' as const),
          file,
          url: URL.createObjectURL(file),
        })),
      ].slice(0, MAX_FILES),
    );
  };

  useEffect(() => {
    if (!rec) return;
    const timer = setInterval(() => {
      setRecMs(rec.elapsed());
      setRecLevel(rec.level());
      // At the limit, or when the recorder died on its own: send what we have.
      if (rec.elapsed() >= VOICE_MAX_MS || !rec.alive()) stopVoice(true);
    }, 100);
    return () => clearInterval(timer);
  }, [rec]);
  // Leaving the chat mid-recording discards it (and frees the microphone).
  const recRef = useRef(rec);
  recRef.current = rec;
  useEffect(() => () => recRef.current?.cancel(), []);

  async function startVoice() {
    if (!canRecord()) return showToast(t('rec.unsupported'));
    // Created inside the tap: iOS would keep a later AudioContext silent.
    const ctx = new AudioContext();
    try {
      const stream = await openStream('audio');
      setRecMs(0);
      setRec(startRecording(stream, 'audio', ctx));
    } catch (e) {
      ctx.close().catch(() => {});
      showToast((e as DOMException)?.name === 'NotAllowedError' ? t('rec.noMic') : t('rec.failed'));
    }
  }

  async function stopVoice(send: boolean) {
    const r = rec;
    if (!r) return;
    setRec(null);
    if (!send) return r.cancel();
    let out;
    try {
      out = await r.stop();
    } catch {
      return showToast(t('rec.failed'));
    }
    if (out.d < 700) return showToast(t('rec.tooShort'));
    props.onSent();
    await sendMessage(chat.id, '', [{ kind: 'voice', blob: out.blob, mime: out.mime, d: out.d, wf: out.wf }], replyTo ?? undefined);
    props.onCancel();
  }

  const sendCircle = (o: Outgoing) => {
    props.onSent();
    sendMessage(chat.id, '', [o], replyTo ?? undefined);
    props.onCancel();
  };
  useImperativeHandle(props.handle, () => ({ addFiles, focus: () => ta.current?.focus() }));

  useEffect(() => {
    if (editing) {
      setText(editing.p?.t ?? '');
      ta.current?.focus();
    }
  }, [editing?.id]);
  useEffect(() => {
    if (replyTo) ta.current?.focus();
  }, [replyTo?.id]);

  useEffect(() => {
    const link = linkPreviews.value && !editing ? firstLink(text) : undefined;
    if (!link || link === noCard) return setCard(null);
    if (card?.from === link) return;
    const timer = setTimeout(() => {
      linkCard(link).then(
        (lp) => {
          // Too big a picture would not fit the message; the text still does.
          if (lp.i && lp.i.length > 30000) lp.i = undefined;
          if (textNow.current.includes(link)) setCard({ from: link, lp });
        },
        () => {},
      );
    }, 700);
    return () => clearTimeout(timer);
  }, [text, noCard]);

  useEffect(() => {
    if (!editing) drafts.set(chat.id, text);
    const el = ta.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  }, [text]);

  // The format bar follows the textarea selection; "selectionchange" is
  // the event that also fires on mobile Safari.
  useEffect(() => {
    const check = () => {
      const el = ta.current;
      setHasSel(!!el && document.activeElement === el && el.selectionStart !== el.selectionEnd);
    };
    document.addEventListener('selectionchange', check);
    return () => document.removeEventListener('selectionchange', check);
  }, []);

  function wrap(kind: 'bold' | 'italic' | 'strike' | 'code' | 'quote') {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const sel = value.slice(s, e);
    const marks = { bold: '**', italic: '__', strike: '~~', code: '`', quote: '' };
    const out =
      kind === 'quote'
        ? sel
            .split('\n')
            .map((l) => '> ' + l)
            .join('\n')
        : marks[kind] + sel + marks[kind];
    el.setRangeText(out, s, e, 'select');
    setText(el.value);
  }

  function insert(str: string) {
    const el = ta.current;
    if (!el) return setText(text + str);
    el.setRangeText(str, el.selectionStart, el.selectionEnd, 'end');
    setText(el.value);
  }

  async function send() {
    const body = text.trim();
    if (body.length > MAX_LEN) {
      showToast(t('chat.tooLong'));
      return;
    }
    if (editing) {
      if (!body && !editing.p?.a?.length) return;
      setText(drafts.get(chat.id) ?? '');
      props.onCancel();
      try {
        await editMessage(editing, body);
      } catch (e) {
        showToast(errText(e));
      }
      return;
    }
    if (!body && !files.length) return;
    const sending: Outgoing[] = files.map((f) => ({ kind: f.kind, file: f.file }));
    const lp = card && body.includes(card.from) ? card.lp : undefined;
    setCard(null);
    files.forEach((f) => URL.revokeObjectURL(f.url));
    setText('');
    setFiles([]);
    drafts.delete(chat.id);
    props.onCancel();
    props.onSent();
    await sendMessage(chat.id, body, sending, replyTo ?? undefined, lp);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !coarse.matches && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && rec) {
      e.preventDefault();
      stopVoice(false);
    } else if (e.key === 'Escape' && (replyTo || editing)) {
      e.preventDefault();
      if (editing) setText(drafts.get(chat.id) ?? '');
      props.onCancel();
    } else if (e.key === 'ArrowUp' && !text && !editing) {
      props.onEditLast();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i')) {
      e.preventDefault();
      wrap(e.key === 'b' ? 'bold' : 'italic');
    }
  }

  const context = editing ?? replyTo;
  const canSend = !!text.trim() || files.length > 0;

  return (
    <div class="composer-wrap">
      {context && (
        <div class="composer-context">
          <Icon name={editing ? 'edit' : 'reply'} />
          <div class="composer-context-text">
            <b>{editing ? t('chat.editing') : context.user === myId() ? t('list.you') : nameOf(chat.id, context.user)}</b>
            <span>{summary(context.p)}</span>
          </div>
          <IconButton
            icon="close"
            label={t('common.cancel')}
            onClick={() => {
              if (editing) setText(drafts.get(chat.id) ?? '');
              props.onCancel();
            }}
          />
        </div>
      )}
      {card && (
        <div class="composer-context">
          <Icon name="link" />
          <div class="composer-context-text">
            <b>{card.lp.s || card.lp.t}</b>
            <span>{card.lp.s ? card.lp.t || card.lp.d : card.lp.d}</span>
          </div>
          <IconButton
            icon="close"
            label={t('chat.noPreview')}
            onClick={() => {
              setNoCard(card.from);
              setCard(null);
            }}
          />
        </div>
      )}
      {files.length > 0 && (
        <ul class="composer-files">
          {files.map((f, i) => (
            <li key={f.url}>
              {f.kind === 'image' ? (
                <img src={f.url} alt="" />
              ) : f.kind === 'clip' ? (
                <video src={f.url} muted playsInline preload="metadata" aria-label={f.file.name} />
              ) : (
                <span class="pending-file" title={f.file.name}>
                  <Icon name="file" />
                  <small>{f.file.name}</small>
                </span>
              )}
              <IconButton
                icon="close"
                label={t('chat.remove')}
                class="remove"
                onClick={() => {
                  URL.revokeObjectURL(f.url);
                  setFiles(files.filter((_, j) => j !== i));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {hasSel && (
        <div class="format-bar" role="toolbar" aria-label="Format">
          {(['bold', 'italic', 'strike', 'code', 'quote'] as const).map((k) => (
            <IconButton key={k} icon={k} label={t('chat.' + k)} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap(k)} />
          ))}
        </div>
      )}
      <div class="composer">
        {rec ? (
          <div class="composer-field recording" role="status">
            <IconButton icon="trash" label={t('rec.cancel')} onClick={() => stopVoice(false)} />
            <span class="rec-dot" aria-hidden="true" />
            <span class="rec-time">{fmtDuration(recMs)}</span>
            <span class="rec-level" aria-hidden="true">
              <i style={{ transform: `scaleX(${Math.max(0.04, recLevel)})` }} />
            </span>
          </div>
        ) : (
          <div class="composer-field">
            <IconButton icon="smile" label={t('chat.emoji')} aria-expanded={emoji} onClick={() => setEmoji(!emoji)} />
            <textarea
              ref={ta}
              rows={1}
              value={text}
              placeholder={t('chat.input')}
              aria-label={t('chat.input')}
              maxLength={MAX_LEN + 100}
              onInput={(e) => {
                setText(e.currentTarget.value);
                sendTyping(chat.id);
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const pasted = [...(e.clipboardData?.files ?? [])];
                if (pasted.length) {
                  e.preventDefault();
                  addFiles(pasted);
                }
              }}
            />
            {!editing && (
              <IconButton icon="attach" label={t('att.menu')} aria-expanded={menu} onClick={() => setMenu(!menu)} />
            )}
            <input
              ref={photoInput}
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.currentTarget.files ?? [])]);
                e.currentTarget.value = '';
              }}
            />
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.currentTarget.files ?? [])], true);
                e.currentTarget.value = '';
              }}
            />
          </div>
        )}
        {rec || canSend || editing || !canRecord() ? (
          <button
            type="button"
            class="send-btn"
            aria-label={editing ? t('common.save') : t('chat.send')}
            title={editing ? t('common.save') : t('chat.send')}
            disabled={!rec && !canSend}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (rec ? stopVoice(true) : send())}
          >
            <Icon name={editing ? 'check' : 'send'} />
          </button>
        ) : (
          <button type="button" class="send-btn" aria-label={t('rec.voice')} title={t('rec.voice')} onClick={startVoice}>
            <Icon name="mic" />
          </button>
        )}
      </div>
      {menu && (
        <div class="menu-layer" onPointerDown={(e) => e.target === e.currentTarget && setMenu(false)}>
          <div class="menu attach-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => (setMenu(false), photoInput.current?.click())}>
              <Icon name="image" /> {t('att.photos')}
            </button>
            <button type="button" role="menuitem" onClick={() => (setMenu(false), fileInput.current?.click())}>
              <Icon name="file" /> {t('att.files')}
            </button>
            {canRecord() && (
              <button type="button" role="menuitem" onClick={() => (setMenu(false), setCircle(true))}>
                <Icon name="circle" /> {t('att.circle')}
              </button>
            )}
          </div>
        </div>
      )}
      {circle && <CircleRecorder onSend={sendCircle} onClose={() => setCircle(false)} />}
      {emoji && <EmojiPicker onPick={insert} onClose={() => setEmoji(false)} />}
    </div>
  );
}

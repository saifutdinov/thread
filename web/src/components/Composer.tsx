import { useEffect, useImperativeHandle, useRef, useState } from 'preact/hooks';
import type { Ref } from 'preact';
import { errText, t } from '../lib/i18n';
import { firstLink } from '../lib/markup';
import { linkPreviews } from '../lib/prefs';
import {
  canRecord,
  dragAction,
  fmtDuration,
  fmtSize,
  openStream,
  type Recording,
  startRecording,
  VIDEO_MAX_MS,
  VOICE_MAX_MS,
} from '../lib/recorder';
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
import { circleShot } from './Media';
import { Icon, IconButton } from './ui';

const MAX_LEN = 4096;
const MAX_FILES = 10;
const drafts = new Map<number, string>();
const coarse = matchMedia('(pointer: coarse)');

// The record button works like Telegram's: hold to record, let go to
// send; a tap switches between a voice message and a video circle;
// dragging up locks the recording, dragging left throws it away.
type RecKind = 'voice' | 'circle';
let lastKind: RecKind = 'voice'; // the next chat starts with the last choice
const HOLD_MS = 250; // a shorter press is a tap

// Press: a hold under way, from the press to the recording's start.
interface Press {
  x: number;
  y: number;
  ctx?: AudioContext; // made inside the press: iOS keeps a later one silent
  timer?: ReturnType<typeof setTimeout>;
  holding: boolean; // past HOLD_MS: the microphone (or camera) is opening
  locked: boolean;
}

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
  // Link preview for the first link in the text (opt-in, see prefs).
  const [card, setCard] = useState<{ from: string; lp: LinkCard } | null>(null);
  const [noCard, setNoCard] = useState(''); // a link whose card was closed
  const textNow = useRef(text);
  textNow.current = text;
  const [rec, setRec] = useState<Recording | null>(null);
  const [recKind, setRecKind] = useState<RecKind>(lastKind); // what the button records next, or is recording
  const [locked, setLocked] = useState(false);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [recMs, setRecMs] = useState(0);
  const [recLevel, setRecLevel] = useState(0);
  const press = useRef<Press | null>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const sendBtn = useRef<HTMLButtonElement>(null);
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
      if (rec.elapsed() >= (recKind === 'voice' ? VOICE_MAX_MS : VIDEO_MAX_MS) || !rec.alive()) stopRec(true);
    }, 100);
    if (recKind === 'circle' && preview.current) preview.current.srcObject = rec.stream;
    return () => clearInterval(timer);
  }, [rec]);
  // Leaving the chat mid-recording discards it (and frees the microphone).
  const recRef = useRef(rec);
  recRef.current = rec;
  useEffect(
    () => () => {
      recRef.current?.cancel();
      dropPress();
    },
    [],
  );

  // dropPress ends a press that has no recording (yet): one opening later
  // sees it gone and lets the microphone go.
  function dropPress() {
    const p = press.current;
    press.current = null;
    clearTimeout(p?.timer);
    if (!rec) p?.ctx?.close().catch(() => {});
  }

  function pressDown(x: number, y: number) {
    if (rec || press.current) return;
    if (!canRecord()) return showToast(t('rec.unsupported'));
    const ctx = recKind === 'voice' ? new AudioContext() : undefined;
    ctx?.resume().catch(() => {});
    const p: Press = { x, y, ctx, holding: false, locked: false };
    p.timer = setTimeout(() => ((p.holding = true), void begin(p)), HOLD_MS);
    press.current = p;
  }

  // startLocked: a keyboard or screen reader "click" has no hold; it
  // starts a locked recording, sent with the send button.
  function startLocked() {
    if (rec || press.current || !canRecord()) return;
    const p: Press = { x: 0, y: 0, ctx: recKind === 'voice' ? new AudioContext() : undefined, holding: true, locked: true };
    press.current = p;
    void begin(p);
  }

  async function begin(p: Press) {
    const kind = recKind;
    try {
      const stream = await openStream(kind === 'voice' ? 'audio' : 'video');
      if (press.current !== p) return stream.getTracks().forEach((tr) => tr.stop()); // let go meanwhile
      setRecMs(0);
      setDrag({ dx: 0, dy: 0 });
      setLocked(p.locked);
      if (p.locked) press.current = null;
      setRec(startRecording(stream, kind === 'voice' ? 'audio' : 'video', p.ctx));
      navigator.vibrate?.(20);
    } catch (e) {
      p.ctx?.close().catch(() => {});
      if (press.current === p) press.current = null;
      const denied = (e as DOMException)?.name === 'NotAllowedError' || (e as DOMException)?.name === 'NotFoundError';
      showToast(denied ? t(kind === 'voice' ? 'rec.noMic' : 'rec.noCamera') : t('rec.failed'));
    }
  }

  function pressMove(x: number, y: number) {
    const p = press.current;
    if (!p?.holding) return;
    const dx = x - p.x;
    const dy = y - p.y;
    const act = dragAction(dx, dy);
    if (act === 'cancel') {
      if (rec) stopRec(false);
      else dropPress();
    } else if (act === 'lock') lockPress();
    else if (rec) setDrag({ dx, dy });
  }

  // lockPress: the recording goes on without the finger (one still
  // opening starts locked).
  function lockPress() {
    const p = press.current;
    if (!p) return;
    p.locked = true;
    if (rec) {
      press.current = null;
      setLocked(true);
    }
  }

  function pressUp() {
    const p = press.current;
    if (!p) return;
    p.ctx?.resume().catch(() => {}); // a touch's release counts as a gesture where its press did not
    if (!p.holding) {
      // A tap: switch between a voice message and a circle.
      dropPress();
      lastKind = recKind === 'voice' ? 'circle' : 'voice';
      setRecKind(lastKind);
      showToast(t(lastKind === 'voice' ? 'rec.nowVoice' : 'rec.nowCircle'));
    } else if (p.locked) {
      return; // still opening, locked on the way: it records on its own
    } else if (rec) {
      stopRec(true);
    } else {
      dropPress(); // let go before the microphone opened
    }
  }

  // Locked by keyboard (the hold button is gone): the send button takes
  // the focus.
  useEffect(() => {
    if (locked) sendBtn.current?.focus();
  }, [locked]);

  async function stopRec(send: boolean) {
    // Once only: the old render's timer may still fire before the new one
    // drops it, and would send the recording twice.
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    const shot = recKind === 'circle' ? circleShot(preview.current) : null; // before the preview goes
    press.current = null;
    setRec(null);
    setLocked(false);
    if (!send) return r.cancel();
    let out;
    try {
      out = await r.stop();
    } catch {
      return showToast(t('rec.failed'));
    }
    if (out.d < 700) return showToast(t('rec.tooShort'));
    props.onSent();
    const item: Outgoing = shot
      ? { kind: 'video', blob: out.blob, mime: out.mime, d: out.d, ...shot }
      : { kind: 'voice', blob: out.blob, mime: out.mime, d: out.d, wf: out.wf };
    await sendMessage(chat.id, '', [item], replyTo ?? undefined);
    props.onCancel();
  }

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
  // A chat opened on a computer is ready to type in. Not on a phone: the
  // keyboard would cover the messages one came to read.
  useEffect(() => {
    if (!coarse.matches && !editing) ta.current?.focus({ preventScroll: true });
  }, []);

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
      <div class="composer" onKeyDown={(e) => rec && e.key === 'Escape' && (e.preventDefault(), stopRec(false))}>
        {rec ? (
          <div class="composer-field recording" role="status">
            {locked && <IconButton icon="trash" label={t('rec.cancel')} onClick={() => stopRec(false)} />}
            <span class="rec-dot" aria-hidden="true" />
            <span class="rec-time">{fmtDuration(recMs)}</span>
            {locked ? (
              recKind === 'voice' && (
                <span class="rec-level" aria-hidden="true">
                  <i style={{ transform: `scaleX(${Math.max(0.04, recLevel)})` }} />
                </span>
              )
            ) : (
              <span class="rec-slide" style={{ transform: `translateX(${Math.min(0, drag.dx) / 2}px)` }}>
                {t('rec.slideCancel')}
              </span>
            )}
          </div>
        ) : (
          <div class="composer-field">
            <IconButton icon="smile" label={t('chat.emoji')} aria-expanded={emoji} onClick={() => setEmoji(!emoji)} />
            <textarea
              ref={ta}
              rows={1}
              value={text}
              spellcheck={false}
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
        {(rec && locked) || canSend || editing || !canRecord() ? (
          <button
            key="send"
            ref={sendBtn}
            type="button"
            class="send-btn"
            aria-label={editing ? t('common.save') : t('chat.send')}
            title={editing ? t('common.save') : t('chat.send')}
            disabled={!rec && !canSend}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (rec ? stopRec(true) : send())}
          >
            <Icon name={editing ? 'check' : 'send'} />
          </button>
        ) : (
          // Kept in place from press to release: the pointer is captured on it.
          <button
            key="hold"
            type="button"
            class={'send-btn rec-hold' + (rec ? ' holding' : '')}
            style={{ '--lvl': rec ? recLevel : 0 }}
            aria-label={t(recKind === 'voice' ? 'rec.holdVoice' : 'rec.holdCircle')}
            title={t(recKind === 'voice' ? 'rec.holdVoice' : 'rec.holdCircle')}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              pressDown(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => pressMove(e.clientX, e.clientY)}
            onPointerUp={pressUp}
            // Taken by the system (a swipe from the edge, a call): keep what was recorded.
            onPointerCancel={() => (press.current?.holding ? lockPress() : dropPress())}
            onContextMenu={(e) => e.preventDefault()}
            // Space works like a finger (tap switches, hold records, release
            // sends); Enter or a screen reader's click starts a locked one.
            // Space's own click is cancelled on both ends.
            onKeyDown={(e) => {
              if (e.key !== ' ') return;
              e.preventDefault();
              if (!e.repeat) pressDown(0, 0);
            }}
            onKeyUp={(e) => {
              if (e.key !== ' ') return;
              e.preventDefault();
              pressUp();
            }}
            onClick={(e) => e.detail === 0 && startLocked()}
          >
            <Icon name={recKind === 'voice' ? 'mic' : 'circle'} />
          </button>
        )}
        {rec && !locked && (
          <div class="rec-lock" style={{ transform: `translateY(${Math.min(0, drag.dy) / 2}px)` }} aria-hidden="true">
            <Icon name="lock" />
          </div>
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
          </div>
        </div>
      )}
      {rec && recKind === 'circle' && (
        <div class="circle-live" aria-hidden="true">
          <div class="circle-preview mirror">
            <video ref={preview} autoPlay muted playsInline />
            <svg class="ring" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="48" stroke-dasharray={2 * Math.PI * 48} stroke-dashoffset={2 * Math.PI * 48 * (1 - recMs / VIDEO_MAX_MS)} />
            </svg>
          </div>
        </div>
      )}
      {emoji && <EmojiPicker onPick={insert} onClose={() => setEmoji(false)} />}
    </div>
  );
}

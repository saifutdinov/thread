import { signal } from '@preact/signals';
import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PendingDevice } from '../lib/api';
import { errText, t } from '../lib/i18n';
import { type Attachment, mediaUrl, showToast } from '../lib/store';

// Material-style 24px glyphs, inlined: no icon font to download.
const PATHS = {
  menu: 'M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z',
  send: 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z',
  attach:
    'M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6z',
  smile:
    'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2M12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8m3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5m-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11m3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  reply: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11',
  copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m0 16H8V7h11z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  checks:
    'M18 7l-1.41-1.41-6.34 6.34 1.41 1.41zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12zM.41 13.41 6 19l1.41-1.41L1.83 12z',
  clock:
    'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2M12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8m.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  alert: 'M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2m-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4m3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0z',
  link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1M8 13h8v-2H8zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 0-10',
  share:
    'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11A2.99 2.99 0 0 0 21 5a3 3 0 0 0-6 0c0 .24.04.47.09.7L8.04 9.81A2.99 2.99 0 0 0 3 12a3 3 0 0 0 5.04 2.19l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92',
  down: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z',
  logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4z',
  download: 'M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z',
  bold: 'M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42M10 6.5h3a1.5 1.5 0 0 1 0 3h-3zm3.5 9H10v-3h3.5a1.5 1.5 0 0 1 0 3',
  italic: 'M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z',
  strike: 'M10 19h4v-3h-4zM5 4v3h5v3h4V7h5V4zM3 14h18v-2H3z',
  quote: 'M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z',
  code: 'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  group:
    'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3m-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3m0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5m8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5',
  person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4m0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4',
  devices:
    'M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1m-1 9h-4v-7h4z',
  phone:
    'M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02z',
  videocam: 'M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z',
  videocamOff: 'M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18zM3.27 2 2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73z',
  micOff:
    'M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28m-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73z',
  callEnd:
    'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9',
  search:
    'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14',
  forward: 'M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11',
  pin: 'M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z',
  up: 'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z',
  mic: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3m5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6zm8-14v14h4V5z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm2 16H8v-2h8zm0-4H8v-2h8zm-3-5V3.5L18.5 9z',
  image: 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2M8.5 13.5l2.5 3.01L14.5 12l4.5 6H5z',
  circle: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16m0-13a5 5 0 1 0 0 10 5 5 0 0 0 0-10',
  flip: 'M16 7h-1l-1-1h-4L9 7H8a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2m-4 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4M8.57.51l4.48 4.48V2.04c4.72.47 8.48 4.23 8.95 8.95h2C23.34 3.02 15.49-1.35 8.57.51m2.38 21.45c-4.72-.47-8.48-4.23-8.95-8.95H0c.66 7.97 8.51 12.34 15.43 10.48l-4.48-4.48z',
  bell: 'M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2m6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1z',
  refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z',
  fit: 'M17 4h3c1.1 0 2 .9 2 2v2h-2V6h-3V4zM4 8V6h3V4H4c-1.1 0-2 .9-2 2v2h2zm16 8v2h-3v2h3c1.1 0 2-.9 2-2v-2h-2zM7 18H4v-2H2v2c0 1.1.9 2 2 2h3v-2zM18 8H6v8h12V8z',
  fill: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  screen: 'M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.11-.9-2-2-2H4c-1.11 0-2 .89-2 2v10c0 1.1.89 2 2 2H0v2h24v-2h-4zm-7-3.53v-2.19c-2.78 0-4.61.85-6 2.72.56-2.67 2.11-5.33 6-5.87V7l4 3.73-4 3.74z',
  screenStop:
    'M21.22 18.02l2 2H24v-2h-2.78zm.77-2l.01-10c0-1.11-.9-2-2-2H7.22l5.23 5.23c.18-.04.36-.07.55-.1V7.02l4 3.73-1.58 1.47 5.54 5.54c.61-.33 1.03-.99 1.03-1.74zM2.39 1.73L1.11 3l1.54 1.54c-.4.36-.65.89-.65 1.48v10c0 1.1.89 2 2 2H0v2h18.13l2.71 2.71 1.27-1.27L2.39 1.73zM7 15.02c.31-1.48.92-2.95 2.07-4.06l1.59 1.59c-1.54.38-2.7 1.18-3.66 2.47z',
  volume: 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77',
  battery: 'M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4',
  bolt: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66s.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21',
  pip: 'M19 11h-8v6h8zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2m-2 .02H3V4.97h18z',
  sparkle: 'M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25z',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
}

export function IconButton(
  props: { icon: IconName; label: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'icon'>,
) {
  const { icon, label, class: cls, ...rest } = props;
  return (
    <button type="button" class={'icon-btn ' + (cls ?? '')} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

// Darker shades than Telegram's palette so white initials stay readable.
const COLORS = ['#c94f57', '#c8691f', '#7c64cf', '#3f9a2d', '#2b9295', '#2f7fc1', '#c4457f'];
export const colorOf = (id: number) => COLORS[Math.abs(id) % COLORS.length];

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function Avatar(props: { id: number; name: string; size?: number; online?: boolean; group?: boolean; src?: string }) {
  const size = props.size ?? 48;
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px`, background: colorOf(props.id) }} aria-hidden="true">
      {props.src ? (
        <img src={props.src} alt="" />
      ) : props.group && !props.name ? (
        <Icon name="group" size={size / 2} />
      ) : (
        <span style={{ fontSize: `${Math.round(size * 0.38)}px` }}>{initials(props.name)}</span>
      )}
      {props.online && <i class="online-dot" />}
    </span>
  );
}

// PictureButtons: pick a new photo (avatar, group photo) or remove it.
export function PictureButtons(props: { has: boolean; onSet: (f: File | null) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const run = async (f: File | null) => {
    setBusy(true);
    try {
      await props.onSet(f);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="picture-buttons">
      <button type="button" class="btn secondary small" disabled={busy} onClick={() => input.current?.click()}>
        <Icon name="image" /> {t('avatar.change')}
      </button>
      {props.has && (
        <button type="button" class="btn secondary small" disabled={busy} onClick={() => run(null)}>
          {t('avatar.remove')}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) run(f);
        }}
      />
    </div>
  );
}

// Modal is a native <dialog>: focus trap, Escape and inert background
// come from the browser, which is what screen readers expect.
export function Modal(props: { label: string; onClose: () => void; children: ComponentChildren; class?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    const cancel = (e: Event) => {
      e.preventDefault();
      close.current();
    };
    d.addEventListener('cancel', cancel);
    return () => {
      d.removeEventListener('cancel', cancel);
      d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      class={'modal ' + (props.class ?? '')}
      aria-label={props.label}
      onClick={(e) => e.target === ref.current && props.onClose()}
    >
      <div class="modal-body">{props.children}</div>
    </dialog>
  );
}

export function Panel(props: { title: string; onBack: () => void; children: ComponentChildren; class?: string }) {
  return (
    <section class={'panel ' + (props.class ?? '')} aria-label={props.title}>
      <header class="bar">
        <IconButton icon="back" label={t('common.back')} onClick={props.onBack} />
        <h1 class="bar-title">{props.title}</h1>
      </header>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map(([v, text]) => (
        <button
          type="button"
          role="radio"
          aria-checked={props.value === v}
          class={props.value === v ? 'on' : ''}
          onClick={() => props.onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Switch(props: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="row switch-row">
      <span class="row-text">
        <span>{props.label}</span>
        {props.hint && <small>{props.hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        class="switch"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

// ---- shared overlays ----

export const lightbox = signal<Attachment | null>(null);
export const approving = signal<PendingDevice | null>(null);

export function EncImage(props: { a: Attachment; fill?: boolean; onOpen?: () => void }) {
  const { a } = props;
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    mediaUrl(a)
      .then((u) => live && setUrl(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [a.id]);
  const style = props.fill
    ? undefined
    : { width: `${(22 * Math.min(1, (a.w ?? 1) / (a.h ?? 1))).toFixed(2)}rem`, aspectRatio: `${a.w ?? 1} / ${a.h ?? 1}` };
  return (
    <button type="button" class={'img' + (props.fill ? ' fill' : '')} style={style} onClick={props.onOpen} aria-label={t('chat.photo')}>
      {a.th && <img src={a.th} alt="" class="thumb" />}
      {url && <img src={url} alt="" class="full" />}
    </button>
  );
}

export function Lightbox() {
  const a = lightbox.value;
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (a) mediaUrl(a).then(setUrl, () => {});
  }, [a?.id]);
  if (!a) return null;
  return (
    <Modal label={t('chat.photo')} onClose={() => (lightbox.value = null)} class="lightbox">
      <div class="lightbox-bar">
        {url && (
          <a class="icon-btn" href={url} download={`photo.${a.m.split('/')[1] ?? 'jpg'}`} aria-label={t('chat.download')} title={t('chat.download')}>
            <Icon name="download" />
          </a>
        )}
        <IconButton icon="close" label={t('common.close')} onClick={() => (lightbox.value = null)} />
      </div>
      <img src={url ?? a.th} alt={t('chat.photo')} class={url ? '' : 'blur'} />
    </Modal>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../lib/i18n';
import { Icon } from './ui';

// CallMenu: the call's own menu instead of the browser's, for both kinds of
// call: the sliders it is given and the person's profile. It lives inside
// the call's <dialog>: a modal one makes everything outside it inert.
// Sliders are not menu items, so it is a group, not a menu.
export function CallMenu(props: { label: string; x: number; y: number; onClose: () => void; onProfile: () => void; children?: ComponentChildren }) {
  const { onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    // Escape, or Tab past either end: the buttons behind must not take focus
    // with the menu still open.
    const keys = (e: KeyboardEvent) => {
      const all = [...ref.current!.querySelectorAll<HTMLElement>('input, button')];
      const at = all.indexOf(document.activeElement as HTMLElement);
      const out = e.key === 'Tab' && (at < 0 || at === (e.shiftKey ? 0 : all.length - 1));
      if (e.key !== 'Escape' && !out) return;
      e.preventDefault(); // not for the call's dialog
      onClose();
      from?.focus();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, []);
  // Stays on screen at any text size, measured rather than assumed.
  useLayoutEffect(() => {
    const m = ref.current!;
    m.style.left = `${Math.max(8, Math.min(props.x, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(props.y, innerHeight - m.offsetHeight - 8))}px`;
  });

  // On click, not on press: closed on press, the layer is gone before the
  // tap lands, and the tap would hit what is under it, even Leave.
  const outside = (e: MouseEvent) => e.target === e.currentTarget && onClose();
  return (
    <div class="menu-layer" onClick={outside} onContextMenu={outside}>
      <div class="menu call-menu" role="group" aria-label={props.label} ref={ref}>
        {props.children}
        <button
          type="button"
          onClick={() => {
            onClose();
            props.onProfile();
          }}
        >
          <Icon name="person" size={20} /> {t('call.profile')}
        </button>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { pushToTalk as talkMode } from '../lib/mic';
export { pushToTalk as talkMode, setPushToTalk as setTalkMode } from '../lib/mic';
import { Hold } from '../lib/hold';
import { t } from '../lib/i18n';
import { Icon } from './ui';

export const talkHold: { current: Hold | null } = { current: null };

export function usePushToTalk(id: string | undefined, active: boolean, mute: (muted: boolean) => unknown) {
  const hold = talkHold;
  const enabled = talkMode.value;
  useEffect(() => {
    if (!id || !enabled || !active) return;
    const h = new Hold((down) => {
      void mute(!down);
    });
    hold.current = h;
    h.reset();
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      if (
        e.type === 'keydown' &&
        ((e.target as HTMLElement)?.closest?.('input,textarea,select,button,[contenteditable="true"],[role="textbox"]') ||
          e.altKey ||
          e.ctrlKey ||
          e.metaKey)
      )
        return;
      e.preventDefault();
      h.set('key', e.type === 'keydown');
    };
    // Buttons release through their owning window, including Document PiP.
    // Main-window blur only owns the main-window keyboard shortcut.
    const reset = () => h.set('key', false);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      h.reset();
      hold.current = null;
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [id, enabled, active, mute]);
  return hold;
}

export function TalkButton(props: { hold: { current: Hold | null }; muted: boolean; full?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  // Symbols remain unique across the main and PiP render roots.
  const sources = useRef({ pointer: Symbol(), button: Symbol() }).current;
  const set = (v: boolean) => props.hold.current?.set(sources.pointer, v);
  const reset = () => {
    props.hold.current?.set(sources.pointer, false);
    props.hold.current?.set(sources.button, false);
  };
  useLayoutEffect(() => {
    const doc = ref.current?.ownerDocument;
    const win = doc?.defaultView;
    win?.addEventListener('blur', reset);
    win?.addEventListener('pagehide', reset);
    doc?.addEventListener('visibilitychange', reset);
    return () => {
      reset();
      win?.removeEventListener('blur', reset);
      win?.removeEventListener('pagehide', reset);
      doc?.removeEventListener('visibilitychange', reset);
    };
  }, [props.hold, sources]);
  return (
    <button
      ref={ref}
      type="button"
      class={props.full ? 'call-btn' : 'icon-btn'}
      aria-label={t('call.holdTalk')}
      title={t('call.holdTalk')}
      aria-pressed={!props.muted}
      style={{ touchAction: 'none', userSelect: 'none' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        set(true);
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
      onKeyDown={(e) => {
        if (e.repeat) return;
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          props.hold.current?.set(sources.button, true);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') props.hold.current?.set(sources.button, false);
      }}
      onBlur={reset}
    >
      <Icon name={props.muted ? 'micOff' : 'mic'} />
      {props.full && <small>{t('call.holdTalk')}</small>}
    </button>
  );
}

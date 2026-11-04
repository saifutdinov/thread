import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { pushToTalk as talkMode } from '../lib/mic';
export { pushToTalk as talkMode, setPushToTalk as setTalkMode } from '../lib/mic';
import { Hold } from '../lib/hold';
import { t } from '../lib/i18n';
import { Icon } from './ui';
import { talkHotkey, globalTalk, talkCapture, probeCompanion } from '../lib/ptt-prefs';
import { hotkeyMatches, hotkeyReleased } from '../lib/hotkey';

export const talkHold: { current: Hold | null } = { current: null };

export function usePushToTalk(id: string | undefined, active: boolean, mute: (muted: boolean) => unknown) {
  const hold = talkHold;
  const enabled = talkMode.value;
  const binding = talkHotkey.value;
  const global = globalTalk.value;
  const capturing = talkCapture.value;
  useEffect(() => {
    if (!id || !enabled || !active || capturing) return;
    const h = new Hold((down) => {
      void mute(!down);
    });
    hold.current = h;
    h.reset();
    const key = (e: KeyboardEvent) => {
      if (e.type === 'keyup') {
        if (hotkeyReleased(binding, e)) h.set('key', false);
        return;
      }
      if (!hotkeyMatches(binding, e)) {
        if (hotkeyReleased(binding, e)) h.set('key', false);
        return;
      }
      if (talkCapture.value || e.repeat || e.isComposing || e.getModifierState?.('AltGraph')) return;
      if (
        e.type === 'keydown' &&
        (e.target as HTMLElement)?.closest?.('input,textarea,select,button,[contenteditable="true"],[role="textbox"]')
      )
        return;
      e.preventDefault();
      h.set('key', e.type === 'keydown');
    };
    // Buttons release through their owning window, including Document PiP.
    // Main-window blur only owns the main-window keyboard shortcut.
    const reset = () => h.set('key', false);
    let session = global ? crypto.randomUUID() : '';
    let last: number | null = null;
    let suspended = false;
    const configure = (on: boolean, connect = global) =>
      window.postMessage({ source: 'thread-ptt', type: 'configure', binding, enabled: on, connect, session }, location.origin);
    const message = (e: MessageEvent) => {
      if (!global || e.source !== window || e.origin !== location.origin || e.data?.source !== 'thread-ptt-extension') return;
      if (e.data.status === 'error' || e.data.status === 'busy') {
        last = null;
        suspended = true;
        session = crypto.randomUUID();
        h.set('global', false);
        return;
      }
      if (e.data.type !== 'state' || e.data.session !== session || typeof e.data.down !== 'boolean') return;
      last = performance.now();
      const editing =
        document.hasFocus() && document.activeElement?.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]');
      h.set('global', e.data.down && !editing && !talkCapture.value && !suspended);
    };
    const freeze = () => {
      h.reset();
      suspended = true;
      last = null;
      if (global) configure(false, false);
    };
    const retry = () => {
      if (global) {
        h.set('global', false);
        last = null;
        suspended = false;
        session = crypto.randomUUID();
        configure(true);
      }
    };
    const watchdog = global
      ? setInterval(() => {
          if (last !== null && performance.now() - last > 1500) retry();
        }, 250)
      : undefined;
    window.addEventListener('message', message);
    window.addEventListener('thread-ptt-retry', retry);
    window.addEventListener('pagehide', freeze);
    window.addEventListener('pageshow', retry);
    document.addEventListener('freeze', freeze);
    document.addEventListener('resume', retry);
    probeCompanion();
    if (global) configure(true);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      h.reset();
      hold.current = null;
      clearInterval(watchdog);
      if (global) configure(false, false);
      window.removeEventListener('message', message);
      window.removeEventListener('thread-ptt-retry', retry);
      window.removeEventListener('pagehide', freeze);
      window.removeEventListener('pageshow', retry);
      document.removeEventListener('freeze', freeze);
      document.removeEventListener('resume', retry);
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [id, enabled, active, mute, binding, global, capturing]);
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

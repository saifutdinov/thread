export interface Hotkey {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}
export const DEFAULT_HOTKEY: Hotkey = { code: 'Space', ctrl: false, alt: false, shift: false, meta: false };
const codes =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Backspace|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete)$/;
export function parseHotkey(value: unknown): Hotkey | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string' || !codes.test(v.code)) return null;
  if (['ctrl', 'alt', 'shift', 'meta'].some((k) => typeof v[k] !== 'boolean')) return null;
  if (v.code === 'Tab' || (/^(Arrow|Home|End|PageUp|PageDown)/.test(v.code) && !v.ctrl && !v.alt && !v.shift && !v.meta)) return null;
  return { code: v.code, ctrl: v.ctrl as boolean, alt: v.alt as boolean, shift: v.shift as boolean, meta: v.meta as boolean };
}
type Key = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;
export function hotkeyFromEvent(e: Key) {
  return parseHotkey({ code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
}
export function hotkeyMatches(b: Hotkey, e: Key) {
  return b.code === e.code && b.ctrl === !!e.ctrlKey && b.alt === !!e.altKey && b.shift === !!e.shiftKey && b.meta === !!e.metaKey;
}
export function hotkeyReleased(b: Hotkey, e: Key) {
  return e.code === b.code || b.ctrl !== !!e.ctrlKey || b.alt !== !!e.altKey || b.shift !== !!e.shiftKey || b.meta !== !!e.metaKey;
}
export function hotkeyLabel(b: Hotkey, apple = false) {
  const key = b.code
    .replace(/^Key|^Digit/, '')
    .replace('Space', '␣')
    .replace('Arrow', '');
  return [
    b.ctrl && (apple ? '⌃' : 'Ctrl'),
    b.alt && (apple ? '⌥' : 'Alt'),
    b.shift && (apple ? '⇧' : 'Shift'),
    b.meta && (apple ? '⌘' : 'Win'),
    key,
  ]
    .filter(Boolean)
    .join('+');
}

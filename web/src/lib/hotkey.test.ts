import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HOTKEY, hotkeyFromEvent, hotkeyLabel, hotkeyMatches, hotkeyReleased, parseHotkey } from './hotkey.ts';

test('hotkeys use physical key codes and exact modifiers across keyboard layouts', () => {
  const e = { code: 'KeyV', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false };
  const b = hotkeyFromEvent(e)!;
  assert.equal(hotkeyLabel(b), 'Ctrl+Shift+V');
  assert.equal(hotkeyMatches(b, e), true);
  assert.equal(hotkeyMatches(b, { ...e, altKey: true }), false);
  assert.equal(hotkeyReleased(b, { ...e, code: 'ControlLeft', ctrlKey: false }), true);
  assert.equal(hotkeyReleased(b, { ...e, code: 'AltLeft', altKey: true }), true);
  assert.equal(hotkeyReleased(b, { ...e, code: 'KeyC' }), false);
  assert.equal(hotkeyLabel({ ...b, ctrl: false, meta: true }, true), '⇧+⌘+V');
});
test('stored bindings reject malformed data and modifier-only shortcuts', () => {
  for (const v of [null, { code: 'ControlLeft' }, { ...DEFAULT_HOTKEY, code: 'arbitrary' }, { ...DEFAULT_HOTKEY, ctrl: 'true' }])
    assert.equal(parseHotkey(v), null);
  assert.deepEqual(parseHotkey(DEFAULT_HOTKEY), DEFAULT_HOTKEY);
});

test('plain navigation keys cannot take over keyboard navigation', () => {
  for (const code of ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
    assert.equal(parseHotkey({ ...DEFAULT_HOTKEY, code }), null);
    assert.equal(!!parseHotkey({ ...DEFAULT_HOTKEY, code, ctrl: true }), code !== 'Tab');
  }
});

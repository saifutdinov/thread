import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { Hold } from './hold.ts';
import { DEFAULT_HOTKEY, hotkeyMatches, hotkeyReleased } from './hotkey.ts';

function keyboard(global = false) {
  const posted: Record<string, unknown>[] = [];
  let time = 10,
    nonce = 0;
  let watchdog: (() => void) | undefined;
  const source = readFileSync(new URL('../components/PushToTalk.tsx', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('export const talkHold'), source.indexOf('export function TalkButton'));
  const code = stripTypeScriptTypes(hook).replace(/\bexport\s+/g, '');
  const listeners = new Map<string, (event?: unknown) => void>();
  const changes: boolean[] = [];
  const context = vm.createContext({
    Hold,
    hotkeyMatches,
    hotkeyReleased,
    talkHotkey: { value: DEFAULT_HOTKEY },
    globalTalk: { value: global },
    talkCapture: { value: false },
    probeCompanion() {},
    location: { origin: 'https://chat.example.org' },
    crypto: { randomUUID: () => String(++nonce) },
    performance: { now: () => time },
    setInterval: (f: () => void) => {
      watchdog = f;
      return 1;
    },
    clearInterval() {},
    talkMode: { value: true },
    useEffect: (fn: () => void) => fn(),
    window: {
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      removeEventListener() {},
      addEventListener: (name: string, fn: (e?: unknown) => void) => listeners.set(name, fn),
    },
    document: { addEventListener() {}, hasFocus: () => false, activeElement: null },
  });
  vm.runInContext(code + '\nglobalThis.run=usePushToTalk;globalThis.testHold=talkHold;', context);
  (
    context as unknown as {
      run: (id: string, active: boolean, mute: (v: boolean) => void) => void;
    }
  ).run('call', true, (v) => changes.push(v));
  const press = (repeat: boolean) =>
    listeners.get('keydown')!({
      type: 'keydown',
      code: 'Space',
      repeat,
      preventDefault() {},
    });
  return {
    posted,
    tick: (at: number) => {
      time = at;
      watchdog?.();
    },
    native: (data: Record<string, unknown>) =>
      listeners.get('message')!({
        source: (context as unknown as { window: unknown }).window,
        origin: 'https://chat.example.org',
        data: { source: 'thread-ptt-extension', ...data },
      }),
    listeners,
    changes,
    press,
    hold: (context as unknown as { testHold: { current: Hold } }).testHold,
  };
}

test('keyboard auto-repeat after focus loss cannot reopen a muted microphone', () => {
  const { listeners, changes, press } = keyboard();
  press(false);
  listeners.get('blur')!();
  press(true);
  assert.equal(changes.at(-1), true);
  listeners.get('keyup')!({
    type: 'keyup',
    code: 'Space',
    preventDefault() {},
  });
  press(false);
  assert.equal(changes.at(-1), false);
});

test('focus transfer from the main window does not release push-to-talk held in the floating window', () => {
  const { listeners, changes, hold } = keyboard();
  hold.current.set('pip-pointer', true);
  listeners.get('blur')!();
  assert.equal(changes.at(-1), false, 'main-window blur must leave the floating button held');
  hold.current.set('pip-pointer', false);
  assert.equal(changes.at(-1), true, 'releasing the owning button must still mute');
});

test('key release during IME composition still mutes the microphone', () => {
  const k = keyboard();
  k.press(false);
  assert.equal(k.changes.at(-1), false);
  k.listeners.get('keyup')!({ type: 'keyup', code: 'Space', isComposing: true });
  assert.equal(k.changes.at(-1), true);
});

test('the browser shortcut does not intercept typing in an editable field', () => {
  const k = keyboard();
  k.listeners.get('keydown')!({
    type: 'keydown',
    code: 'Space',
    target: { closest: () => ({}) },
    preventDefault: () => assert.fail('typing was intercepted'),
  });
  assert.equal(k.changes.at(-1), true);
});

test('global hold survives main-window blur and releases on timeout while rejecting the previous session', () => {
  const k = keyboard(true);
  const session = k.posted.at(-1)!.session;
  k.native({ type: 'state', down: true, session });
  assert.equal(k.changes.at(-1), false);
  k.listeners.get('blur')!();
  assert.equal(k.changes.at(-1), false);
  k.tick(1600);
  assert.equal(k.changes.at(-1), true);
  k.native({ type: 'state', down: true, session });
  assert.equal(k.changes.at(-1), true);
  const next = k.posted.at(-1)!.session;
  assert.notEqual(next, session);
  k.native({ type: 'state', down: true, session: next });
  assert.equal(k.changes.at(-1), false);
  k.native({ status: 'error' });
  assert.equal(k.changes.at(-1), true);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { Hold } from './hold.ts';

function keyboard() {
  const source = readFileSync(new URL('../components/PushToTalk.tsx', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('export const talkHold'), source.indexOf('export function TalkButton'));
  const code = stripTypeScriptTypes(hook).replace(/\bexport\s+/g, '');
  const listeners = new Map<string, (event?: unknown) => void>();
  const changes: boolean[] = [];
  const context = vm.createContext({
    Hold,
    talkMode: { value: true },
    useEffect: (fn: () => void) => fn(),
    window: {
      addEventListener: (name: string, fn: (e?: unknown) => void) => listeners.set(name, fn),
    },
    document: { addEventListener() {} },
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

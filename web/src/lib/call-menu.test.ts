import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuKey, voiceForCall, voiceVolume } from './call-menu.ts';

function press(key: string, opts: { shiftKey?: boolean; fromChild?: boolean } = {}) {
  const box = { getBoundingClientRect: () => ({ left: 100, top: 40, width: 60, height: 20 }) };
  const opened: [number, number][] = [];
  let prevented = false;
  menuKey((x, y) => opened.push([x, y]))({
    key,
    shiftKey: !!opts.shiftKey,
    target: opts.fromChild ? {} : box,
    currentTarget: box,
    preventDefault: () => (prevented = true),
  } as unknown as KeyboardEvent);
  return { opened, prevented };
}

test('Enter, the menu key and Shift+F10 open the menu at the middle of the element', () => {
  for (const [key, shiftKey] of [['Enter', false], ['ContextMenu', false], ['F10', true]] as const) {
    assert.deepEqual(press(key, { shiftKey }), { opened: [[130, 50]], prevented: true });
  }
});

test('other keys pass through', () => {
  assert.deepEqual(press('a'), { opened: [], prevented: false });
  assert.deepEqual(press('F10'), { opened: [], prevented: false });
});

test('a key pressed on a control inside stays that control\'s', () => {
  assert.deepEqual(press('Enter', { fromChild: true }), { opened: [], prevented: false });
});

test('their voice level lasts for one call, also through a remount', () => {
  voiceForCall('a');
  voiceVolume.value = 0.2;
  voiceForCall('a'); // the app was locked and unlocked: the screen mounts again
  assert.equal(voiceVolume.value, 0.2);
  voiceForCall('b');
  assert.equal(voiceVolume.value, 1);
});

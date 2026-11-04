import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

// The real message handler, with only its store/browser boundaries replaced.
const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source.slice(source.indexOf('function onMessage('), source.indexOf('\nlet readTimer:')));
function setup(reading: boolean, inCall: boolean, hidden = false, push = false, duringCalls = false) {
  const sounds: string[] = [];
  const chats = { value: [{ id: 1, unread: 0, cleared_upto: 0, lastMsg: { id: 10, seq: 10 } }] };
  const messages = { value: new Map() };
  const context = vm.createContext({
    chats,
    messages,
    findChat: () => chats.value[0],
    myId: () => 1,
    openChatId: () => (reading ? 1 : 2),
    away: () => !reading,
    putMessages: (chat: number, list: unknown[]) => messages.value.set(chat, list),
    markRead() {},
    loadChats() {},
    socketHold: { call: inCall },
    document: { visibilityState: hidden ? 'hidden' : 'visible' },
    pushOn: push,
    playSound: (kind: string) => sounds.push(kind),
    messageSoundAllowed: (call: boolean) => !call || duringCalls,
    notifyHere: () => false,
  });
  vm.runInContext(code + '\nglobalThis.message=onMessage;', context);
  return { sounds, message: (context as unknown as { message: (m: object) => void }).message };
}
const msg = (id: number, seq = id, user = 2, p: object = { t: 'hello' }) => ({ chat: 1, id, seq, user, p });

test('fresh incoming messages sound in the focused chat; calls require an explicit opt-in', () => {
  for (const reading of [false, true])
    for (const inCall of [false, true]) {
      const s = setup(reading, inCall, false, false, true);
      s.message(msg(11));
      assert.deepEqual(s.sounds, ['message']);
      s.message(msg(11));
      s.message(msg(11, 12));
      s.message(msg(9));
      s.message(msg(12, 13, 1));
      s.message(msg(13, 14, 2, { cl: { s: 'ok' } }));
      assert.deepEqual(s.sounds, ['message'], 'duplicates, edits, old/own messages and successful call logs stay quiet');
    }
});

test('message sounds during calls are off by default', () => {
  const s = setup(true, true);
  s.message(msg(11));
  assert.deepEqual(s.sounds, []);
});
test('a hidden page leaves sound to push, but sounds without a push subscription', () => {
  for (const push of [false, true]) {
    const s = setup(false, true, true, push, true);
    s.message(msg(11));
    assert.deepEqual(s.sounds, push ? [] : ['message']);
  }
});

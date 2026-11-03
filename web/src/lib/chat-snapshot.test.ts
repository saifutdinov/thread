import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { latestMessage } from './messages.ts';

const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('let chatsReq:'), source.indexOf('\nfunction putMessages'));
const code = stripTypeScriptTypes(section).replace(/\bexport\s+/g, '');
const last = { id: 5, cid: 'five', seq: 5 };
const initial = { id: 1, cleared_upto: 0, unread: 2, members: [{ id: 1, last_read: 0 }], lastMsg: last };
type Snapshot = Omit<typeof initial, 'lastMsg'> & { lastMsg?: typeof last };

async function race(current: typeof initial, known = [current.lastMsg], snapshot: Snapshot = initial) {
  let finish!: (value: unknown) => void;
  const decoration = new Promise((resolve) => (finish = resolve));
  const chats = { value: [structuredClone(initial)] };
  const messages = { value: new Map([[1, known]]) };
  const context = vm.createContext({
    chats,
    messages,
    loaded: new Set([1]),
    latestMessage,
    myId: () => 1,
    api: { chats: async () => [] },
    decorate: () => decoration,
    batch: (fn: () => void) => fn(),
    findChat: (id: number) => chats.value.find((c) => c.id === id),
    reconcileAvatar: async () => {},
    notePush: async () => {},
  });
  vm.runInContext(code + '\nglobalThis.run = loadChats;', context);
  const request = (context as unknown as { run: () => Promise<void> }).run();
  await new Promise((r) => setImmediate(r));
  chats.value = [current];
  finish([structuredClone(snapshot)]);
  await request;
  return chats.value[0];
}

test('a delayed chat snapshot keeps a newer message preview and unread count', async () => {
  const current = { ...initial, unread: 3, lastMsg: { id: 6, cid: 'six', seq: 6 } };
  const result = await race(current);
  assert.equal(result.lastMsg.id, 6);
  assert.equal(result.unread, 3);
});

test('a delayed chat snapshot cannot undo a local read or another-device read receipt', async () => {
  const result = await race({ ...initial, unread: 0, members: [{ id: 1, last_read: 5 }] });
  assert.equal(result.unread, 0);
  assert.equal(result.members[0].last_read, 5);
});

test('a delayed chat snapshot cannot restore a deleted message or cleared history', async () => {
  const removed = { ...last, seq: 7, deleted: true };
  assert.equal((await race({ ...initial, lastMsg: removed }, [removed])).lastMsg, undefined);
  assert.equal((await race({ ...initial, cleared_upto: 5 })).lastMsg, undefined);
});

test('an authoritative refresh after offline does not keep an obsolete cached last message', async () => {
  const older = { ...initial, unread: 1, lastMsg: { id: 4, cid: 'four', seq: 4 } };
  const result = await race(initial, [last], older);
  assert.equal(result.lastMsg.id, 4);
  assert.equal(result.unread, 1);
  const empty = await race(initial, [last], { ...initial, unread: 0, lastMsg: undefined });
  assert.equal(empty.lastMsg, undefined);
  assert.equal(empty.unread, 0);
});

test('an optimistic read of the old last message does not hide a newer unread message', async () => {
  const current = { ...initial, unread: 0, members: [{ id: 1, last_read: 5 }] };
  const snapshot = { ...initial, unread: 1, lastMsg: { id: 6, cid: 'six', seq: 6 } };
  const result = await race(current, [last], snapshot);
  assert.equal(result.unread, 1);
  assert.equal(result.lastMsg.id, 6);
});

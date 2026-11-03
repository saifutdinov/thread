import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestMessage, mergeMessages } from './messages.ts';

test('a delayed decrypt or history response cannot undo a deletion or edit', () => {
  const removed = { id: 1, cid: 'one', seq: 12, deleted: true };
  const old = { id: 1, cid: 'one', seq: 11, deleted: false };
  assert.deepEqual(mergeMessages([removed], [old]), [removed]);
  assert.deepEqual(mergeMessages([old], [removed]), [removed]);
  const edited = { ...old, seq: 13, text: 'edited' };
  assert.deepEqual(mergeMessages([edited], [old]), [edited]);
});

test('a late failed local send cannot duplicate an already delivered message', () => {
  const pending = { id: 1e15, cid: 'one', seq: 0, local: 'sending' };
  const saved = { id: 4, cid: 'one', seq: 9 };
  assert.deepEqual(mergeMessages([pending], [saved]), [saved]);
  assert.deepEqual(mergeMessages([saved], [{ ...pending, local: 'failed' }]), [saved]);
});

test('chat previews respect newer edits, deletions and clear-history boundaries', () => {
  const old = { id: 5, cid: 'five', seq: 1 };
  const edited = { ...old, seq: 3, text: 'edited' };
  assert.deepEqual(latestMessage([old, edited]), edited);
  assert.equal(latestMessage([old, { ...old, seq: 4, deleted: true }]), undefined);
  assert.equal(latestMessage([edited], 5), undefined);
});

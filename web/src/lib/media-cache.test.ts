import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaCache } from './media-cache.ts';

test('media cache deduplicates decrypts and evicts unused URLs without interrupting a player', async () => {
  let reads = 0,
    next = 0;
  const revoked: string[] = [];
  const cache = new MediaCache(4, 2, { create: () => `blob:${++next}`, revoke: (u) => revoked.push(u) });
  const load = async () => {
    reads++;
    return new Blob(['1234']);
  };
  const first = cache.acquire('one', load),
    same = cache.acquire('one', load);
  assert.equal(await first.url, await same.url);
  assert.equal(reads, 1);
  const second = cache.acquire('two', load);
  await second.url;
  first.release();
  assert.deepEqual(revoked, []);
  same.release();
  same.release();
  assert.deepEqual(revoked, ['blob:1']);
  second.release();
  cache.clear();
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
});

test('clearing while a decrypt is pending cannot recreate a logged-out media URL', async () => {
  let finish!: (b: Blob) => void,
    created = 0;
  const cache = new MediaCache(4, 2, { create: () => String(++created), revoke: () => {} });
  const lease = cache.acquire('one', () => new Promise((r) => (finish = r)));
  await Promise.resolve();
  cache.clear();
  finish(new Blob(['x']));
  await assert.rejects(lease.url, /released/);
  assert.equal(created, 0);
  lease.release();
});

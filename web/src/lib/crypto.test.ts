// Run: npm test (node:test with type stripping, no extra dependencies).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aesKey,
  concat,
  deviceCode,
  fingerprint,
  fromB64,
  inviteKeys,
  newDeviceKeys,
  open,
  pinHash,
  rand,
  safetyCode,
  seal,
  sign,
  toB64,
  toB64u,
  unwrapKey,
  utf8,
  verify,
  wrapKey,
} from './crypto.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

test('invite derivation matches the Go server and Python reference', async () => {
  const secret = new Uint8Array(32).map((_, i) => i + 1);
  const { auth, id } = await inviteKeys(secret);
  assert.equal(hex(auth), 'cfa1c0ae7a5d292a57d42139a28db8cc02f918c61c66199f28e4b87f70fc0cdc');
  assert.equal(hex(id), '751c296517665c5cb25bb8e4651e496b3f2c8f21205f9f7ff5d09a0319be4ac3');
});

test('invite wrap key opens what it sealed, and nothing else does', async () => {
  const a = await inviteKeys(rand(32));
  const b = await inviteKeys(rand(32));
  const blob = await seal(a.wrap, 'invite', utf8('{"k":{}}'));
  assert.equal(Buffer.from(await open(a.wrap, 'invite', blob)).toString(), '{"k":{}}');
  await assert.rejects(open(b.wrap, 'invite', blob));
});

test('device private keys cannot be exported', async () => {
  const k = await newDeviceKeys();
  assert.equal(k.encPub.length, 65);
  assert.equal(k.sigPub.length, 65);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', k.enc.privateKey));
  await assert.rejects(crypto.subtle.exportKey('pkcs8', k.sig.privateKey));
});

test('chat key wrap round-trips only for the right device and epoch', async () => {
  const alice = await newDeviceKeys();
  const mallory = await newDeviceKeys();
  const chatKey = rand(32);
  const wrapped = await wrapKey(chatKey, alice.encPub, 3);
  assert.equal(wrapped.length, 125); // server checks exactly this size
  assert.deepEqual(await unwrapKey(wrapped, alice.enc.privateKey, 3), chatKey);
  await assert.rejects(unwrapKey(wrapped, alice.enc.privateKey, 4));
  await assert.rejects(unwrapKey(wrapped, mallory.enc.privateKey, 3));
  const again = await wrapKey(chatKey, alice.encPub, 3);
  assert.notEqual(hex(again), hex(wrapped)); // fresh ephemeral key each time
});

test('messages are bound to their AAD and tamper-evident', async () => {
  const key = await aesKey(rand(32));
  const pt = utf8(JSON.stringify({ t: 'Привет **мир**' }));
  const a = await seal(key, 'm:1:1', pt);
  const b = await seal(key, 'm:1:1', pt);
  assert.notEqual(hex(a.slice(0, 12)), hex(b.slice(0, 12))); // random IVs
  assert.deepEqual(await open(key, 'm:1:1', a), pt);
  await assert.rejects(open(key, 'm:2:1', a)); // moved to another chat
  const bad = a.slice();
  bad[20] ^= 1;
  await assert.rejects(open(key, 'm:1:1', bad));
});

test('signatures are raw 64-byte P1363 and verify only for the signer', async () => {
  const d = await newDeviceKeys();
  const other = await newDeviceKeys();
  const data = concat(utf8('m:1:1'), rand(40));
  const sig = await sign(d.sig.privateKey, data);
  assert.equal(sig.length, 64);
  assert.equal(await verify(d.sigPub, sig, data), true);
  assert.equal(await verify(other.sigPub, sig, data), false);
  const changed = data.slice();
  changed[0] ^= 1;
  assert.equal(await verify(d.sigPub, sig, changed), false);
  assert.equal(await verify(d.sigPub, sig.slice(0, 63), data), false);
});

test('device code is stable and readable', async () => {
  const d = await newDeviceKeys();
  const a = await deviceCode(d.encPub, d.sigPub);
  const b = await deviceCode(d.encPub, d.sigPub);
  assert.deepEqual(a, b);
  assert.equal(a.emoji.length, 4);
  assert.match(a.digits, /^\d{3} \d{3}$/);
});

test('base64 helpers match Go encoding/json and URL fragments', () => {
  const big = new Uint8Array(100_000).map((_, i) => (i * 7) & 255); // larger than the 0x8000 chunk
  assert.deepEqual(fromB64(toB64(big)), big);
  const b = new Uint8Array([251, 255, 0, 1]);
  assert.equal(toB64(b), Buffer.from(b).toString('base64')); // padded std, like Go
  assert.equal(toB64u(b), Buffer.from(b).toString('base64url'));
  assert.deepEqual(fromB64(toB64u(b)), b);
});

test('safety code is the same on both sides and tracks device changes', async () => {
  const dev = async () => {
    const k = await newDeviceKeys();
    return { enc_pub: toB64(k.encPub), sig_pub: toB64(k.sigPub) };
  };
  const [a1, a2, b1] = [await dev(), await dev(), await dev()];
  const alice = await fingerprint([a1, a2]);
  const bob = await fingerprint([b1]);
  assert.deepEqual(await fingerprint([a2, a1]), alice); // device order does not matter
  const fromAlice = await safetyCode(alice, bob);
  const fromBob = await safetyCode(bob, alice);
  assert.deepEqual(fromAlice, fromBob);
  assert.equal(fromAlice.emoji.length, 4);
  assert.match(fromAlice.digits, /^\d{3} \d{3} \d{3} \d{3}$/);
  // Bob adds a device (or a server slips one in): the code changes.
  const changed = await safetyCode(alice, await fingerprint([b1, await dev()]));
  assert.notEqual(changed.digits, fromAlice.digits);
});

test('PIN hash is salted and deterministic', async () => {
  const salt = rand(16);
  assert.deepEqual(await pinHash('1234', salt), await pinHash('1234', salt));
  assert.notDeepEqual(await pinHash('1234', salt), await pinHash('1235', salt));
  assert.notDeepEqual(await pinHash('1234', salt), await pinHash('1234', rand(16)));
});

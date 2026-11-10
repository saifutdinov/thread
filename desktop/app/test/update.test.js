import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { choose, newer, pick, sha256, signed } from '../lib/update.js';

const files = [
  { name: 'Thread-Setup-0.24.0.exe', platform: 'windows', version: '0.24.0' },
  { name: 'Thread-0.24.0-arm64.dmg', platform: 'mac-arm', version: '0.24.0' },
  { name: 'Thread-0.24.0-x64.dmg', platform: 'mac-intel', version: '0.24.0' },
  { name: 'Thread-0.24.0-amd64.deb', platform: 'linux-deb', version: '0.24.0' },
  { name: 'Thread-0.24.0-x86_64.AppImage', platform: 'linux-appimage', version: '0.24.0' },
];

test('each computer takes its own installer', () => {
  assert.equal(pick(files, 'win32', 'x64', '')?.name, 'Thread-Setup-0.24.0.exe');
  assert.equal(pick(files, 'darwin', 'arm64', '')?.name, 'Thread-0.24.0-arm64.dmg');
  assert.equal(pick(files, 'darwin', 'x64', '')?.name, 'Thread-0.24.0-x64.dmg');
  assert.equal(pick(files, 'linux', 'x64', '/home/a/Thread.AppImage')?.name, 'Thread-0.24.0-x86_64.AppImage');
  assert.equal(pick(files, 'linux', 'x64', '')?.name, 'Thread-0.24.0-amd64.deb');
  assert.equal(pick(files, 'freebsd', 'x64', ''), null);
});

test('versions compare by number, and anything odd is not newer', () => {
  assert.equal(newer('0.24.0', '0.23.3'), true);
  assert.equal(newer('0.23.10', '0.23.9'), true);
  assert.equal(newer('0.23.3', '0.23.3'), false);
  assert.equal(newer('0.23.2', '0.23.3'), false);
  assert.equal(newer('1.0.0', 'dev'), false);
  assert.equal(newer('x.y.z', '0.1.0'), false);
});

test('only a manifest the update key signed is believed', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const body = Buffer.from(JSON.stringify({ release: 'v0.24.0', files }));
  const sig = sign(null, body, privateKey).toString('base64');
  assert.equal(signed(body, sig, raw)?.release, 'v0.24.0');
  // Changed by one byte, signed by another key, or no key at all: refused.
  const changed = Buffer.from(body.toString().replace('0.24.0', '0.24.1'));
  assert.equal(signed(changed, sig, raw), null);
  const other = generateKeyPairSync('ed25519').privateKey;
  assert.equal(signed(body, sign(null, body, other).toString('base64'), raw), null);
  assert.equal(signed(body, sig, ''), null);
  assert.equal(signed(body, 'not base64 !!', raw), null);
});

test('sha256 is the hex the manifest carries', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('with a key only a signed manifest offers an update, without one only a download', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const body = Buffer.from(JSON.stringify({ release: 'v0.24.0', files }));
  const sig = sign(null, body, privateKey).toString('base64');
  const here = { platform: 'win32', arch: 'x64', appImage: '', current: '0.23.3' };
  assert.deepEqual(choose({ body, sig, key, ...here }), { file: files[0], trusted: true });
  // The signature lost or forged: nothing at all, not a download either.
  assert.equal(choose({ body, sig: '', key, ...here }), null);
  const forged = Buffer.from(body.toString().replace('0.24.0', '99.0.0'));
  assert.equal(choose({ body: forged, sig, key, ...here }), null);
  // No key in this build: offered, but not trusted to run.
  assert.deepEqual(choose({ body, sig: '', key: '', ...here }), { file: files[0], trusted: false });
  // Nothing newer, or nothing for this computer.
  assert.equal(choose({ body, sig, key, ...here, current: '0.24.0' }), null);
  assert.equal(choose({ body, sig, key, ...here, platform: 'freebsd' }), null);
  assert.equal(choose({ body: Buffer.from('not json'), sig: '', key: '', ...here }), null);
});

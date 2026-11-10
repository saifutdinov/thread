import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { bundled, headersFor, toServer } from '../lib/route.js';

const root = path.resolve('/app/web');
const files = new Set(['index.html', 'sw.js', 'assets/index-1.js', 'audio/rnnoise-worklet.js'].map((f) => path.join(root, f)));
const exists = (f) => files.has(f);
const origin = 'https://chat.example.org';
const at = (p, o = origin) => bundled(new URL(p, o), origin, root, exists);

test('the interface comes from inside the app', () => {
  assert.equal(at('/'), path.join(root, 'index.html'));
  assert.equal(at('/sw.js'), path.join(root, 'sw.js'));
  assert.equal(at('/assets/index-1.js'), path.join(root, 'assets/index-1.js'));
  assert.equal(at('/?v=2#/c/1'), path.join(root, 'index.html'));
});

test('only the API, the call signaling and the health check go to the server', () => {
  const server = (p, o = origin) => toServer(new URL(p, o), origin);
  for (const p of ['/api/me', '/api/', '/api', '/healthz', '/lk', '/lk/rtc']) assert.equal(server(p), true, p);
  // The server answers any other path with its own index.html: its code
  // must never run on the app's origin.
  for (const p of ['/', '/x', '/media/abc', '/api.html', '/lkx', '/healthz/x']) assert.equal(server(p), false, p);
  assert.equal(at('/x'), null, 'not in the bundle: a 404 from the app');
  assert.equal(at('/sw.js', 'https://elsewhere.example'), null, 'another origin is never served from the app');
});

test('no path leaves the bundle', () => {
  assert.equal(at('/../etc/passwd'), null);
  assert.equal(at('/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(at('/assets/..%2f..%2fsecret'), null);
  assert.equal(at('/%00'), null);
});

test('a bundled response carries the server\'s own policy for this origin', () => {
  const h = headersFor(path.join(root, 'assets/index-1.js'), origin);
  assert.equal(h['content-type'], 'text/javascript; charset=utf-8');
  assert.match(h['content-security-policy'], /connect-src 'self' wss:\/\/chat\.example\.org ws:\/\/chat\.example\.org/);
  assert.match(h['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(headersFor(path.join(root, 'x.wasm'), origin)['content-type'], 'application/wasm');
  assert.equal(headersFor(path.join(root, 'index.html'), origin)['cache-control'], 'no-cache');
});

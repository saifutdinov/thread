import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOrigin } from '../lib/config.js';

test('a server is an https origin, or http on this computer for development', () => {
  assert.equal(parseOrigin('https://chat.example.org'), 'https://chat.example.org');
  assert.equal(parseOrigin('https://chat.example.org/'), 'https://chat.example.org');
  assert.equal(parseOrigin('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(parseOrigin('http://127.0.0.1:18080'), 'http://127.0.0.1:18080');
});

test('anything else is refused: the app trusts this one origin with the person\'s keys', () => {
  for (const bad of ['http://chat.example.org', 'ftp://chat.example.org', 'https://chat.example.org/app', 'https://chat.example.org/?x=1', 'https://user@chat.example.org', 'chat.example.org', '']) {
    assert.throws(() => parseOrigin(bad), undefined, bad);
  }
});

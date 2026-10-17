import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lang, t } from './i18n.ts';

test('russian plurals', () => {
  lang.value = 'ru';
  const cases: [number, string][] = [
    [1, '1 участник'],
    [2, '2 участника'],
    [5, '5 участников'],
    [11, '11 участников'],
    [12, '12 участников'],
    [21, '21 участник'],
    [22, '22 участника'],
    [111, '111 участников'],
  ];
  for (const [n, want] of cases) assert.equal(t('chat.members', { n }), want);
});

test('english plurals and params', () => {
  lang.value = 'en';
  assert.equal(t('chat.members', { n: 1 }), '1 member');
  assert.equal(t('chat.members', { n: 3 }), '3 members');
  assert.equal(t('invite.direct', { name: 'Anna' }), 'Anna invites you to a private chat');
});

test('every key exists in both languages', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./i18n.ts', import.meta.url), 'utf8'));
  const block = (name: string) => src.slice(src.indexOf(`const ${name}:`), src.indexOf('};', src.indexOf(`const ${name}:`)));
  const keys = (name: string) => new Set([...block(name).matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]));
  const ru = keys('ru');
  const en = keys('en');
  assert.deepEqual([...ru].filter((k) => !en.has(k)), []);
  assert.deepEqual([...en].filter((k) => !ru.has(k)), []);
  assert.ok(ru.size > 150);
});

test('every error code the server sends has a translation', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../../../internal/server/', import.meta.url);
  const codes = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((n: string) => n.endsWith('.go') && !n.endsWith('_test.go'))) {
    for (const m of fs.readFileSync(new URL(f, dir), 'utf8').matchAll(/fail\(w, [^,]+, "(\w+)"\)/g)) codes.add(m[1]);
  }
  assert.ok(codes.size > 10);
  for (const code of codes) assert.notEqual(t('err.' + code), 'err.' + code, `missing err.${code}`);
});

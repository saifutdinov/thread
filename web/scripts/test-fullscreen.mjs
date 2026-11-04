// A stream on the whole display, and the patch notes, in a real browser. The
// call is a fixture: nothing here needs a server, and nothing makes a sound.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { patchNotes } from '../src/lib/patch-notes.ts';

const version = patchNotes[0].version;
process.env.VITE_VERSION = version;
const fixture = new URL('../.call-test-tools/fullscreen/', import.meta.url);
await mkdir(fixture, { recursive: true });
await writeFile(new URL('index.html', fixture), '<!doctype html><html lang="ru" data-theme="dark"><head><meta charset="utf-8"><title>Fullscreen check</title></head><body><div id="app"></div><script type="module" src="./entry.tsx"></script></body></html>');
await writeFile(new URL('entry.tsx', fixture), `
import { h, render } from 'preact';
import { CallScreen } from '/src/components/Call.tsx';
import { GroupCallScreen } from '/src/components/GroupCall.tsx';
import { PatchBanner, PatchNotes } from '/src/components/PatchNotes.tsx';
import { call } from '/src/lib/call.ts';
import { groupCall } from '/src/lib/group.ts';
import { lang } from '/src/lib/i18n.ts';
import { chats, me } from '/src/lib/store.ts';
import '/src/styles.css';
lang.value = 'ru';
const canvas = document.createElement('canvas');
canvas.getContext('2d').fillRect(0, 0, 10, 10);
const stream = canvas.captureStream(5);
const screen = { attach(el) { el.srcObject = stream; }, detach() {} };
me.value = { user: { id: 1 } };
chats.value = [
  { id: 7, kind: 'group', members: [{ id: 1, name: 'Я' }, { id: 2, name: 'Анна' }] },
  { id: 9, kind: 'direct', members: [{ id: 1, name: 'Я' }, { id: 2, name: 'Анна' }] },
];
const app = document.getElementById('app');
const person = (id, user, more) => ({ id, user, me: user === 1, speaking: false, muted: false, ...more });
window.fixture = { call, groupCall };
if (location.hash === '#group') {
  groupCall.value = { id: 'x', chat: 7, phase: 'active', muted: false, camOff: true, since: Date.now(), people: [person('1.1.a', 1), person('2.1.a', 2, { screen })] };
  render(h(GroupCallScreen), app);
} else if (location.hash === '#direct') {
  call.value = { id: 'a', chat: 9, peer: 2, phase: 'active', video: true, muted: false, camOff: true, since: Date.now(), peerScreen: true, remote: stream };
  render(h(CallScreen), app);
} else render(h('div', null, h(PatchBanner), h(PatchNotes)), app);
`);
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 },
  cacheDir: fileURLToPath(new URL('vite-cache/', fixture)),
  optimizeDeps: { noDiscovery: true, include: ['preact', 'preact/hooks', 'preact/jsx-runtime', 'preact/jsx-dev-runtime', 'preact/debug', 'preact/devtools', '@preact/signals'] },
});
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}/.call-test-tools/fullscreen/index.html`;
  browser = await chromium.launch({ ...(process.env.BROWSER_BINARY ? { executablePath: process.env.BROWSER_BINARY } : { channel: 'chromium' }), headless: true, args: ['--mute-audio'] });
  const open = async (hash, slow = 0) => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    page.on('pageerror', (error) => assert.fail(error.message));
    if (slow) await page.addInitScript((ms) => {
      const real = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function () { return new Promise((resolve) => setTimeout(resolve, ms)).then(() => real.call(this)); };
    }, slow);
    await page.goto(base + hash);
    return page;
  };
  const fs = (page) => page.evaluate(() => !!document.fullscreenElement);
  const wide = (page) => page.locator('.gtile.full').count();
  const narrow = (page) => page.waitForFunction(() => !document.querySelector('.gtile.full'), null, { timeout: 3000 });
  // The browser reports the change on the next frame: a person is never faster.
  const entered = async (page, on) => {
    await page.waitForFunction((want) => !!document.fullscreenElement === want, on);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  };

  let page = await open('#group');
  await page.click('.gtile-full');
  await entered(page, true);
  assert.equal(await wide(page), 1);
  assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true);
  assert.equal(await page.evaluate(() => !!document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest('dialog')), true, 'the call stays on top of the page');
  assert.equal(await page.locator('.call-controls').evaluate((el) => getComputedStyle(el).visibility), 'hidden', 'Leave must not take focus unseen');
  await page.mouse.click(300, 300, { button: 'right' });
  await page.waitForSelector('.menu');
  assert.equal(await page.evaluate(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return document.querySelector('.menu').contains(document.elementFromPoint(r.left + 50, r.top + 20)); }), true, 'the menu stays above the stream');
  await page.mouse.click(40, 700);
  await page.waitForFunction(() => !document.querySelector('.menu'));
  await page.click('.gtile-full');
  await entered(page, false);
  await narrow(page);
  await page.dblclick('.gtile.screen video');
  await entered(page, true);
  await page.evaluate(() => document.exitFullscreen()); // what Escape does
  await entered(page, false);
  await narrow(page);
  await page.click('.gtile-full');
  await entered(page, true);
  await page.evaluate(() => { const f = window.fixture.groupCall; f.value = { ...f.value, people: f.value.people.map((p) => ({ ...p, screen: undefined })) }; });
  await entered(page, false);
  await narrow(page);
  await page.close();

  // A second click while the browser is still entering.
  page = await open('#group', 300);
  await page.click('.gtile-full');
  await page.click('.gtile-full');
  await page.waitForTimeout(800);
  assert.equal(await fs(page), false, 'a late request must not leave the page full screen with no way back');
  assert.equal(await wide(page), 0);
  await page.close();

  page = await open('#direct');
  await page.click('.call-fit');
  await entered(page, true);
  await page.evaluate(() => { const f = window.fixture.call; f.value = { ...f.value, peerScreen: false, video: false }; });
  await entered(page, false);
  await page.close();

  page = await open('');
  await page.waitForSelector('.patch-notes');
  assert.equal(await page.locator('.patch-notes details').count(), patchNotes.length);
  await page.click('.notif-banner .btn');
  assert.equal(await page.locator('dialog.modal .patch-note li').count(), patchNotes[0].ru.length);
  await page.click('dialog.modal .btn');
  await page.reload();
  await page.waitForSelector('.patch-notes');
  assert.equal(await page.locator('.notif-banner').count(), 0, 'the notes are shown once per release');
  console.log('Stream on the whole display and patch notes passed.');
} finally { await browser?.close(); await server.close(); }

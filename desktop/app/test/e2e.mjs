// The desktop app against a real server, in a real Electron. The server gets
// no web build at all: whatever interface shows came from inside the app.
// Silent: the app runs with --mute-audio.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

// No trailing separator: on Windows "C:\app\" ends the quoted argument
// with an escaped quote, and Electron gets a broken app path.
const appDir = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const repo = path.resolve(appDir, '..', '..');
const dir = await mkdtemp(path.join(os.tmpdir(), 'thread-desktop-'));
const free = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const base = `http://localhost:${free}`;
const binary = path.join(dir, process.platform === 'win32' ? 'thread.exe' : 'thread');
let server, app, invite;
try {
  execFileSync(process.env.GO_BINARY || 'go', ['build', '-o', binary, './cmd/thread'], { cwd: repo, stdio: 'inherit' });
  await mkdir(path.join(dir, 'data'));
  await mkdir(path.join(dir, 'empty'));
  server = spawn(binary, [], {
    env: { ...process.env, ADDR: `127.0.0.1:${new URL(base).port}`, BASE_URL: base, DATA_DIR: path.join(dir, 'data'), STATIC_DIR: path.join(dir, 'empty'), PASSWORD_PEPPER: Buffer.alloc(32, 7).toString('base64') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.url?.includes('/#/i/')) invite = event.url;
        } catch {}
      }
    });
  }
  for (let i = 0; !invite && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(invite, 'no first invite from the server');

  app = await _electron.launch({ args: [appDir], env: { ...process.env, THREAD_ORIGIN: base, THREAD_TEST: '1' } });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  assert.equal(await page.evaluate(() => location.origin), base, 'same origin as the server');
  assert.equal((await page.evaluate(() => fetch('/healthz').then((r) => r.json()))).status, 'ok', 'the API goes to the server');
  const csp = await page.evaluate(() => fetch('/').then((r) => r.headers.get('content-security-policy')));
  assert.match(csp, new RegExp(`connect-src 'self' wss://localhost:${new URL(base).port}`), 'the bundle carries the policy');
  assert.deepEqual(await page.evaluate(() => [typeof require, typeof process, typeof window.connectApp?.show]), ['undefined', 'undefined', 'function'], 'no Node in the page');
  assert.equal(await page.evaluate(() => window.open('https://example.org')), null, 'no new windows');
  // The server answers unknown paths with its own index.html: the app must not.
  assert.equal(await page.evaluate(() => fetch('/x').then((r) => r.status)), 404, 'only the API reaches the server');
  // No redirect is followed for the page (the server sends /api to /api/).
  assert.equal(await page.evaluate(() => fetch('/api').then(() => 'followed', () => 'refused')), 'refused');
  assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), 0, 'no service worker in the app');

  // The labels below are Russian; a runner's system language is not.
  await page.evaluate(() => localStorage.setItem('lang', 'ru'));
  await page.reload();
  await page.evaluate((hash) => (location.hash = hash), new URL(invite).hash);
  await page.getByLabel('Как вас зовут?', { exact: true }).fill('Test Desktop');
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await page.getByLabel('Я записал(а) пароль', { exact: true }).check();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.waitForFunction(() => fetch('/api/me').then((r) => r.ok));
  // The app is installed: no "add to home screen" guide over it (it would
  // render together with the chat list).
  await page.locator('.sidebar-body').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'no install guide in the app');
  assert.equal(await page.locator('text=Нет соединения').count(), 0);

  // A large body streams through the app to the server intact.
  await page.evaluate(() => (location.hash = '#/new'));
  await page.getByRole('button', { name: 'Создать приглашение', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть чат', exact: true }).click();
  await page.waitForFunction(() => /^#\/c\/\d+$/.test(location.hash));
  const uploaded = await page.evaluate(async () => {
    const chat = location.hash.split('/')[2];
    const body = new Uint8Array(3 << 20).map((_, i) => i % 251);
    const r = await fetch(`/api/media?chat=${chat}`, { method: 'POST', body: new Blob([body]) });
    const { id } = await r.json();
    const back = new Uint8Array(await (await fetch(`/api/media/${id}`)).arrayBuffer());
    return [r.status, back.length, back.every((b, i) => b === i % 251)];
  });
  assert.deepEqual(uploaded, [200, 3 << 20, true]);

  // Notifications are the system's own; a click opens the chat in place.
  // Linux shows them through a desktop's notification service; a CI runner under xvfb has none.
  if (process.platform !== 'linux') assert.equal(await app.evaluate(({ Notification }) => Notification.isSupported()), true);
  await page.evaluate(() => window.connectApp.notify({ title: 'test', tag: 'e2e', silent: true, url: '/#/settings' }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open', '/#/settings'));
  await page.waitForFunction(() => location.hash === '#/settings');
  await page.evaluate(() => window.connectApp.clear('e2e'));

  await page.evaluate(() => (location.href = 'https://example.org/'));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await page.evaluate(() => location.origin), base, 'leaving the origin is refused');
  // Both went to the browser in a real app; in a test they are only kept.
  assert.deepEqual(await app.evaluate(() => globalThis.openedExternally), ['https://example.org/', 'https://example.org/']);
  console.log('Desktop app: interface from inside, API, policy, sign-up, socket and guards passed.');
} finally {
  await app?.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  // Windows holds a just-stopped .exe a moment longer; a failed cleanup
  // must not hide the test's own error.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch((e) => console.warn('cleanup:', e.message));
}

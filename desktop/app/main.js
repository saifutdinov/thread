// The desktop app: the same web interface, carried inside the app, with what
// a browser tab cannot do: tray, start at login, a window over the others,
// push-to-talk over other apps and a screen with its sound. docs/adr/0007.
import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrigin } from './lib/config.js';
import { Frames, frame } from './lib/frames.js';
import { bundled, headersFor, toServer } from './lib/route.js';
import { Talk } from './lib/talk.js';
import { choose, sha256 } from './lib/update.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const resources = app.isPackaged ? process.resourcesPath : repo;
const webRoot = app.isPackaged ? path.join(resources, 'web') : path.join(repo, 'web', 'dist');
const config = JSON.parse(readFileSync(path.join(app.isPackaged ? resources : here, 'app-config.json'), 'utf8'));
// A development build may point elsewhere; a packaged one trusts its own config only.
const origin = parseOrigin((!app.isPackaged && process.env.THREAD_ORIGIN) || config.origin);
const companion =
  process.platform === 'win32' ? path.join(resources, app.isPackaged ? 'thread-hotkeys.exe' : 'desktop/thread-hotkeys.exe') : '';
const ru = () => app.getLocale().startsWith('ru');
const isFile = (f) => statSync(f, { throwIfNoEntry: false })?.isFile() === true;
const ours = (url) => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

let win = null;
let tray = null;
let quitting = false;

// A released app takes no debugging switches: through them another program
// could drive the session. The fuses already block Node's inspector. Asked
// of Chromium's own parser, which also takes -x, /x and any case on Windows.
const debugging = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags'];
if (app.isPackaged && debugging.some((s) => app.commandLine.hasSwitch(s))) app.exit(1);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => show());
app.setAppUserModelId(config.appId); // Windows shows notifications only for a known app id
// Tests (an unpackaged app with THREAD_TEST=1) make no sound and open
// nothing in the person's browser: links that would go there are kept in
// globalThis.openedExternally for the test to read.
const testing = !app.isPackaged && process.env.THREAD_TEST === '1';
if (testing) app.commandLine.appendSwitch('mute-audio');
globalThis.openedExternally = [];
const external = (url) => {
  if (!/^https?:/.test(url)) return;
  if (testing) globalThis.openedExternally.push(url);
  else void shell.openExternal(url);
};

function show() {
  if (!win) return;
  win.show();
  win.focus();
}

const talk = new Talk({
  start: () => {
    if (!isFile(companion)) return null;
    const child = spawn(companion, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.stdin.on('error', () => {}); // a companion gone before ready: 'exit' reports it
    const frames = new Frames();
    const host = { send: (m) => child.stdin.write(frame(m)), stop: () => child.kill() };
    child.stdout.on('data', (chunk) => {
      try {
        for (const m of frames.push(chunk)) talk.fromHost(m);
      } catch {
        child.kill();
      }
    });
    child.on('exit', () => talk.host === host && talk.hostGone());
    child.on('error', () => talk.host === host && talk.hostGone());
    return host;
  },
  toPage: (m) => win?.webContents.send('talk', m),
});

// Only the app's own page, in its main frame, may use the app's functions.
const fromPage = (e) => e.sender === win?.webContents && e.senderFrame === e.sender.mainFrame && ours(e.senderFrame.url);
ipcMain.on('talk', (e, m) => fromPage(e) && talk.fromPage(m));
ipcMain.handle('talk:available', (e) => fromPage(e) && isFile(companion));
ipcMain.on('show', (e) => fromPage(e) && show());

// Updates from this app's server, checked against the owner's update key
// (lib/update.js, docs/updates.md). Without a key in app-config.json, or a
// signature that does not check out, the installer is only offered in the
// browser, the way a person would download it by hand.
const serverFetch = (name) =>
  session.defaultSession.fetch(`${origin}/api/downloads/${name}`, { bypassCustomProtocolHandlers: true, redirect: 'error', cache: 'no-store' });
async function updateFor() {
  const [m, s] = await Promise.all([serverFetch('manifest.json'), serverFetch('manifest.sig')]);
  if (!m.ok) return null;
  return choose({
    body: Buffer.from(await m.arrayBuffer()),
    sig: s.ok ? await s.text() : '',
    key: config.updateKey ?? '',
    platform: process.platform,
    arch: process.arch,
    appImage: process.env.APPIMAGE ?? '',
    current: app.getVersion(),
  });
}
ipcMain.handle('update:check', async (e) => {
  if (!fromPage(e) || !app.isPackaged) return null;
  const u = await updateFor().catch(() => null);
  return u && { version: u.file.version };
});
ipcMain.handle('update:install', async (e) => {
  if (!fromPage(e) || !app.isPackaged) return 'none';
  const u = await updateFor();
  if (!u) return 'none';
  const url = `${origin}/api/downloads/${encodeURIComponent(u.file.name)}`;
  if (!u.trusted) {
    external(url);
    return 'browser';
  }
  const res = await serverFetch(encodeURIComponent(u.file.name));
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok || sha256(bytes) !== u.file.sha256) throw new Error('update');
  const leave = () => setTimeout(() => ((quitting = true), app.quit()), 800);
  const image = process.env.APPIMAGE;
  if (process.platform === 'linux' && image) {
    // The AppImage replaces itself: written beside it (one filesystem, so the
    // rename is atomic; /tmp is often another) and started again from its
    // own path, not from its mount, which goes away with it.
    const next = path.join(path.dirname(image), `.${path.basename(image)}.new`);
    try {
      await writeFile(next, bytes, { mode: 0o755 });
      await chmod(next, 0o755);
      await rename(next, image);
    } catch {
      await rm(next, { force: true }).catch(() => {});
      external(url); // a folder it cannot write: the browser, by hand
      return 'browser';
    }
    app.relaunch({ execPath: image, args: process.argv.slice(1) });
    app.exit(0);
    return 'installing';
  }
  // A folder of its own: in a shared /tmp no one else's link or file is followed.
  const dir = await mkdtemp(path.join(app.getPath('temp'), 'thread-update-'));
  const file = path.join(dir, path.basename(u.file.name));
  await writeFile(file, bytes);
  if (process.platform === 'win32') {
    // NSIS, silent, then the new version starts by itself. The app closes
    // only once the installer runs: blocked by an antivirus, it stays open.
    return new Promise((resolve, reject) => {
      const child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        leave();
        resolve('installing');
      });
    });
  }
  // macOS (an unsigned app cannot replace itself) and .deb: the system opens it.
  await shell.openPath(file);
  if (process.platform === 'darwin') leave(); // Finder replaces Thread only when it is closed
  return 'opened';
});

// The system's own notifications: a service worker's do not work in Electron.
// Kept by tag, so a later one replaces it and clear() can take it away; a
// click opens the window on the chat (web/src/lib/notify.ts).
const notes = new Map();
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
ipcMain.on('notify', (e, n) => {
  if (!fromPage(e) || !Notification.isSupported()) return;
  const tag = text(n?.tag, 64);
  notes.get(tag)?.close();
  // The app's own icon: a chat's picture comes from another member, and the
  // main process, which is not sandboxed, would have to decode it.
  const note = new Notification({
    title: text(n?.title, 200),
    body: text(n?.body, 1000),
    silent: n?.silent === true,
    timeoutType: n?.sticky ? 'never' : 'default',
    icon: appIcon,
  });
  const url = text(n?.url, 200).startsWith('/') ? text(n.url, 200) : '/';
  note.on('click', () => {
    show();
    win?.webContents.send('open', url);
  });
  note.on('close', () => notes.get(tag) === note && notes.delete(tag));
  notes.set(tag, note);
  note.show();
});
ipcMain.on('notify:clear', (e, tag) => {
  if (!fromPage(e)) return;
  notes.get(text(tag, 64))?.close();
  notes.delete(text(tag, 64));
});

// The screen to show: Windows has no system picker, so the app asks with
// its own window. With sound only on Windows, where Chromium can loop it back.
let picking = false; // one picker at a time
function pick(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win,
      modal: true,
      width: 720,
      height: 520,
      title: ru() ? 'Что показать' : 'What to share',
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(here, 'picker-preload.cjs'), contextIsolation: true, sandbox: true, devTools: !app.isPackaged },
    });
    const list = sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
    const done = (id) => {
      ipcMain.removeHandler('picker:list');
      ipcMain.removeAllListeners('picker:choose');
      resolve(id);
      if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.handle('picker:list', (e) => (e.sender === picker.webContents ? { ru: ru(), list } : null));
    ipcMain.on('picker:choose', (e, id) => e.sender === picker.webContents && done(typeof id === 'string' ? id : null));
    picker.on('closed', () => done(null));
    void picker.loadFile(path.join(here, 'picker.html'));
  });
}

function protect(ses) {
  // The interface from inside the app, the rest from the server (lib/route.js).
  ses.protocol.handle(new URL(origin).protocol.slice(0, -1), async (req) => {
    const url = new URL(req.url);
    // No redirect is followed: here it would bring any origin's body back as
    // if it were the server's, and Chromium cannot take one back from this
    // handler. The server's API never redirects on purpose.
    if (url.origin !== origin || toServer(url, origin)) return ses.fetch(req, { bypassCustomProtocolHandlers: true, redirect: 'error' });
    const file = (req.method === 'GET' || req.method === 'HEAD') && bundled(url, origin, webRoot, isFile);
    if (!file) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response(req.method === 'HEAD' ? null : await readFile(file), { headers: headersFor(file, origin) });
  });
  const allowed = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed.has(permission) && ours(details.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.has(permission) && ours(requestingOrigin));
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      // Every request is answered, or the page waits forever.
      if (picking || !ours(request.securityOrigin)) return callback({});
      picking = true;
      let chosen;
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
        const id = sources.length ? await pick(sources) : null;
        chosen = sources.find((s) => s.id === id);
      } catch {
        chosen = undefined;
      } finally {
        picking = false;
      }
      if (!chosen) return callback({});
      callback({ video: chosen, audio: request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined });
    },
    { useSystemPicker: true }, // macOS 15 and later: the system's own
  );
}

// Windows reports the login item only for the same arguments it was set
// with; macOS ignores arguments and says whether it opened the app at
// login; Linux has no such setting.
const loginArgs = ['--hidden'];
const login = () => app.getLoginItemSettings(process.platform === 'win32' ? { args: loginArgs } : undefined);
const atLogin = () => process.argv.includes('--hidden') || (process.platform === 'darwin' && login().wasOpenedAtLogin);

function trayMenu() {
  const t = ru()
    ? { open: 'Открыть', top: 'Поверх других окон', login: 'Запускать при входе', quit: 'Выйти' }
    : { open: 'Open', top: 'Keep on top', login: 'Start at login', quit: 'Quit' };
  return Menu.buildFromTemplate([
    { label: t.open, click: show },
    {
      label: t.top,
      type: 'checkbox',
      checked: !!win?.isAlwaysOnTop(),
      click: (item) => win?.setAlwaysOnTop(item.checked, 'floating'),
    },
    ...(process.platform === 'linux'
      ? []
      : [
          {
            label: t.login,
            type: 'checkbox',
            checked: login().openAtLogin,
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: loginArgs }),
          },
        ]),
    { type: 'separator' },
    {
      label: t.quit,
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // Leaving the app's origin opens the browser instead, by a link or by a
  // redirect. The server's own paths are not pages: a window opened on one
  // would run whatever the server answered on the app's origin.
  const leave = (e, url) => {
    if (ours(url) && !toServer(new URL(url), origin)) return;
    e.preventDefault();
    // An installer (/api/downloads) is the browser's to download.
    if (!ours(url) || new URL(url).pathname.startsWith('/api/downloads/')) external(url);
  };
  wc.on('will-navigate', leave);
  wc.on('will-redirect', leave);
  wc.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
});

app.on('before-quit', () => (quitting = true));
app.on('activate', () => show()); // macOS: the Dock icon brings the window back
app.on('window-all-closed', () => {}); // the tray keeps the app, so a call can still ring

let appIcon;
app.whenReady().then(async () => {
  // The app's page needs no service worker, and one left from before would
  // fetch on its own.
  await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  protect(session.defaultSession);
  // No View menu with developer tools in a released app; macOS keeps Edit
  // for copy and paste.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const icon = nativeImage.createFromPath(path.join(webRoot, 'icon-192.png'));
  appIcon = icon;
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    title: config.name,
    icon,
    show: !atLogin(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
      // A call rings and the socket is checked in the background too.
      backgroundThrottling: false,
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // to the tray: the app keeps its socket for calls
    win.hide();
  });
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(config.name);
  tray.on('click', show);
  tray.setContextMenu(trayMenu());
  win.on('always-on-top-changed', () => tray.setContextMenu(trayMenu()));
  void win.loadURL(origin + '/');
});

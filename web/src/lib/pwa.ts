import { signal } from '@preact/signals';
import { api } from './api';
import { fromB64 } from './crypto';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const ua = navigator.userAgent;
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
// Phones and tablets freeze pages in the background; computers keep them running.
export const mobile = isIOS || /Android/i.test(ua);
// The installed apps: the desktop one (desktop/app) and the Android one
// (android/). Their notifications are the system's own and neither has
// Web Push. The desktop app keeps its socket open in the background; the
// Android app gets FCM pushes instead (the optional members below).
// Absent in a browser.
export interface NativeApp {
  version: string;
  platform: string;
  show(): void;
  notify(note: AppNote): void;
  clear(tag: string): void;
  onOpen(open: (url: string) => void): void;
  // Android: its FCM token for the server, a copy of what sw.js reads from
  // IndexedDB (it shows pushes with no page), calls held in a foreground
  // service, files into Downloads, and the notification taps sw.js would post.
  pushToken?(): Promise<string>;
  keep?(key: string, value: unknown): void;
  callState?(on: boolean, video: boolean, ringing: boolean): void;
  notificationsOn?(): Promise<boolean>;
  save?(url: string, name: string): void;
  onMessage?(fn: (m: { t: string; [k: string]: unknown }) => void): void;
  // The phone's photos and videos, newest first; null without access (Gallery.kt).
  gallery?(): Promise<GalleryItem[] | null>;
  // The screen at full brightness (the front camera's ring light), or back to the system's.
  brightness?(on: boolean): void;
  // Updates from this server (docs/updates.md): a newer build for this
  // system, then its install: "installing" (Windows, AppImage, Android's
  // installer), "opened" (a Mac's DMG, a .deb), "browser" (no update key:
  // offered as a download), "permission" (Android must allow installs first).
  checkUpdate?(): Promise<{ version: string } | null>;
  installUpdate?(): Promise<string>;
}
// k: kind, m: type, d: length in ms (videos), s: bytes, n: file name.
export interface GalleryItem { id: number; k: 'image' | 'video'; m: string; w: number; h: number; d: number; s: number; n: string }
export type AppNote = { title: string; body?: string; tag?: string; silent?: boolean; sticky?: boolean; url?: string };
export const nativeApp = (window as { connectApp?: NativeApp }).connectApp;
// appPush: pushes reach this device through its app (FCM), not Web Push.
export const appPush = !!nativeApp?.pushToken;

// An app is installed by definition: no "add to home screen" guide in it.
export const standalone = signal(
  !!nativeApp || matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
);

export const pushSupported = !nativeApp && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// The Android app asks for the system permission itself, at its first start,
// and says whether it has it (android.ts).
export const notifPermission = signal<NotificationPermission | 'unsupported'>(
  appPush ? 'granted' : pushSupported ? Notification.permission : 'unsupported',
);
// The permission may change in the browser's site settings meanwhile.
if (pushSupported)
  navigator.permissions
    ?.query({ name: 'notifications' })
    .then((s) => (s.onchange = () => (notifPermission.value = Notification.permission)))
    .catch(() => {});

// Chromium offers a real install prompt; iOS has none, so the UI shows
// "Share -> Add to Home Screen" instructions instead.
export const installPrompt = signal<InstallPromptEvent | null>(null);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt.value = e as InstallPromptEvent;
});
window.addEventListener('appinstalled', () => {
  installPrompt.value = null;
  standalone.value = true;
});

export async function install() {
  const p = installPrompt.value;
  if (!p) return;
  await p.prompt();
  await p.userChoice;
  installPrompt.value = null;
}

export function registerSW() {
  // The apps have their own notifications and carry their own files.
  if ('serviceWorker' in navigator && !nativeApp) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// enablePush must run from a user gesture (iOS requires it).
export async function enablePush(): Promise<boolean> {
  if (appPush) return subscribe().then(() => pushOn);
  if (!pushSupported) return false;
  const perm = await Notification.requestPermission();
  notifPermission.value = perm;
  if (perm !== 'granted') return false;
  await subscribe();
  return true;
}

// The release this page was built from (Dockerfile VERSION; "dev" locally)
// and whether the server already runs another one: then a reload is due.
export const appVersion: string = import.meta.env.VITE_VERSION || 'dev';
// The interface's own version, a hash of web/ (ci.yml): one release may
// rebuild only the server or one app, and then the interface is the same.
const webVersion: string = import.meta.env.VITE_WEB || '';
export const updateReady = signal(false);

// checkUpdate asks /healthz which release runs now. The socket calls it on
// every open: a deploy restarts the server and every page reconnects, and
// a phone reconnects whenever the app comes back to the front.
// appUpdate: a newer build of this app on the server, by version.
export const appUpdate = signal<string | null>(null);

export async function checkUpdate() {
  if (nativeApp?.checkUpdate) {
    // An app updates as a whole: only a build for this system counts.
    const found = await nativeApp.checkUpdate().catch(() => null);
    appUpdate.value = found?.version ?? null;
    updateReady.value = !!found; // updated by hand meanwhile, or the server went back: no banner
    return;
  }
  try {
    const { version, web } = await (await fetch('/healthz', { cache: 'no-store' })).json();
    // A server or a page from before the interface version: by release.
    if (web && webVersion && web !== 'dev' ? web !== webVersion : version && version !== appVersion) updateReady.value = true;
  } catch {
    /* offline, or a server too old to say: next time */
  }
}

// pushOn: the server holds this device's push subscription (notify.ts).
export let pushOn = false;

// subscribe re-registers silently on every start, so the server always
// holds a live endpoint for this device.
export async function subscribe() {
  if (appPush) {
    const token = await nativeApp!.pushToken!();
    if (!token) return; // no Google services, or FCM not reached yet: next start
    await api.subscribeApp(token);
    pushOn = true;
    return;
  }
  if (!pushSupported || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api.pushKey();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(key) });
  }
  await api.subscribe(sub.toJSON());
  pushOn = true;
}

export async function unsubscribe() {
  if (!pushSupported) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
}

// Besides every socket open: an app left running for days still hears of a new build.
if (nativeApp?.checkUpdate) setInterval(() => void checkUpdate(), 6 * 3600_000);

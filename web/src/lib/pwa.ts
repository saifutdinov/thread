import { signal } from '@preact/signals';
import { api } from './api';
import { fromB64 } from './crypto';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const ua = navigator.userAgent;
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const standalone = signal(
  matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
);
export const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const notifPermission = signal<NotificationPermission | 'unsupported'>(
  pushSupported ? Notification.permission : 'unsupported',
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// enablePush must run from a user gesture (iOS requires it).
export async function enablePush(): Promise<boolean> {
  if (!pushSupported) return false;
  const perm = await Notification.requestPermission();
  notifPermission.value = perm;
  if (perm !== 'granted') return false;
  await subscribe();
  return true;
}

// subscribe re-registers silently on every start, so the server always
// holds a live endpoint for this device.
export async function subscribe() {
  if (!pushSupported || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api.pushKey();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(key) });
  }
  await api.subscribe(sub.toJSON());
}

export async function unsubscribe() {
  if (!pushSupported) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
}

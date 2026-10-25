// System notifications from the open page. The server pushes only to
// devices without a live socket, so a page that is open but not in front
// (another window on top, an unfocused browser) has to tell the system
// itself. Tags match the service worker's (sw.js): a later push replaces
// a notification instead of doubling it.
import { idbGet } from './idb';
import { pushSupported } from './pwa';

const allowed = () => pushSupported && Notification.permission === 'granted';

// away: the person is not looking at this page right now.
export const away = () => document.visibilityState !== 'visible' || !document.hasFocus();

async function show(title: string, options: NotificationOptions & { renotify?: boolean; actions?: { action: string; title: string }[] }) {
  if (!allowed()) return;
  // The service worker's registration: Android allows no page-made
  // `new Notification`, and only it can carry action buttons.
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(title, { icon: '/icon-192.png', ...options });
}

// A new message: who wrote and what, unless the app lock hides previews.
export async function notifyMessage(chat: number, from: string, text: string, fallback: string) {
  const hide = await idbGet<boolean>('hidePreview');
  await show(hide ? fallback : from, {
    body: hide ? '' : text || fallback,
    tag: 'c' + chat,
    renotify: true,
    data: { url: '/#/c/' + chat },
  });
}

// An incoming call stays on screen until answered. Chromium browsers show
// the two buttons; elsewhere a tap opens the app on the ringing call.
export async function notifyCall(chat: number, from: string, body: string, answer: string, decline: string) {
  const hide = await idbGet<boolean>('hidePreview');
  await show(hide ? body : `📞 ${from}`, {
    body: hide ? '' : body,
    tag: 'call',
    renotify: true,
    requireInteraction: true,
    data: { url: '/#/c/' + chat, call: true },
    actions: [
      { action: 'answer', title: answer },
      { action: 'decline', title: decline },
    ],
  });
}

// clear removes notifications with this tag: the chat was read, the call
// answered or over.
export async function clear(tag: string) {
  if (!allowed()) return;
  const reg = await navigator.serviceWorker.ready;
  for (const n of await reg.getNotifications({ tag })) n.close();
}

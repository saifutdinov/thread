// System notifications from the open page. The server pushes to devices
// whose page is hidden (or closed), so a page that is visible but not in
// front (another window on top, an unfocused browser) has to tell the
// system itself. Tags match the service worker's (sw.js): a later push replaces
// a notification instead of doubling it. Best effort: a notification that
// cannot be shown is not worth an error.
import { idbGet } from './idb';
import { pushSupported } from './pwa';

const allowed = () => pushSupported && Notification.permission === 'granted';

// away: the person is not looking at this page right now.
export const away = () => document.visibilityState !== 'visible' || !document.hasFocus();

// behind: visible, but another window has the focus. Only then the page
// notifies: a hidden page gets the server's push, and both would double.
export const behind = () => document.visibilityState === 'visible' && !document.hasFocus();

// The service worker's registration: Android allows no page-made
// `new Notification`, and only it can carry action buttons. None at all
// (registration failed): no notifications, and nothing left waiting.
const registration = () => navigator.serviceWorker.getRegistration().catch(() => undefined);

// Shows and clears run in order: a call answered while its notification
// is still on its way must not leave the notification behind.
let queue: Promise<unknown> = Promise.resolve();
const inOrder = (task: () => Promise<unknown>) => (queue = queue.then(task).catch(() => {}));

type Options = NotificationOptions & { renotify?: boolean; actions?: { action: string; title: string }[] };

// display runs inside the queue only.
async function display(title: string, options: Options) {
  if (allowed()) await (await registration())?.showNotification(title, { icon: '/icon-192.png', ...options });
}

// A new message: who wrote and what, unless the app lock hides previews.
export function notifyMessage(chat: number, from: string, text: string, fallback: string) {
  return inOrder(async () => {
    const hide = await idbGet<boolean>('hidePreview');
    await display(hide || !from ? fallback : from, { body: hide ? '' : text, tag: 'c' + chat, renotify: true, data: { url: '/#/c/' + chat } });
  });
}

// An incoming call stays on screen until answered. Chromium browsers show
// the two buttons; elsewhere a tap opens the app on the ringing call.
export function notifyCall(chat: number, from: string, body: string, answer: string, decline: string) {
  return inOrder(async () => {
    const hide = await idbGet<boolean>('hidePreview');
    await display(hide || !from ? body : `📞 ${from}`, {
      body: hide || !from ? '' : body,
      tag: 'call',
      renotify: true,
      requireInteraction: true,
      data: { url: '/#/c/' + chat, call: true },
      actions: [
        { action: 'answer', title: answer },
        { action: 'decline', title: decline },
      ],
    });
  });
}

// clear removes notifications with this tag: the chat was read, the call
// answered or over.
export function clear(tag: string) {
  return inOrder(async () => {
    if (!allowed()) return;
    for (const n of (await (await registration())?.getNotifications({ tag })) ?? []) n.close();
  });
}

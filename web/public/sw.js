// Thread (Нитка) service worker: offline app shell + Web Push.
// Push payloads hold ciphertext only; the chat key is read from the same
// IndexedDB the app uses (src/lib/idb.ts) and the text is decrypted here.

const CACHE = 'thread-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Network first so updates land at once; cached shell when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
    // Hashed assets never change: cache first.
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

function idbGet(key) {
  return new Promise((resolve) => {
    const open = indexedDB.open('thread', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      try {
        const req = open.result.transaction('kv').objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    };
  });
}

function idbSet(key, value) {
  return new Promise((resolve) => {
    const open = indexedDB.open('thread', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve();
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    };
  });
}

function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const TEXT = {
  ru: { app: 'Нитка', callEnded: 'Этот вызов больше не ожидает ответа', callCheck: 'Откройте Нитку, чтобы проверить звонок', call: 'Входящий звонок', callVideo: 'Входящий видеозвонок', groupCall: 'Зовёт в групповой звонок', groupCallVideo: 'Зовёт в групповой видеозвонок', answer: 'Ответить', decline: 'Отклонить', join: 'Присоединиться', read: 'Прочитано', more: 'новых: {n}', test: 'Уведомления работают', testBody: 'Так будут выглядеть сообщения и звонки.', msg: 'Новое сообщение', photo: '📷 Фото', voice: '🎤 Голосовое сообщение', video: '📹 Видеосообщение', clip: '🎬 Видео', callLog: '📞 Звонок', missed: '📞 Пропущенный звонок', file: '📎 Файл', login: 'Новый вход в аккаунт: {label}. Откройте Нитку, чтобы разрешить или запретить.' },
  en: { app: 'Thread', callEnded: 'This call is no longer ringing', callCheck: 'Open Thread to check the call', call: 'Incoming call', callVideo: 'Incoming video call', groupCall: 'Invites you to a group call', groupCallVideo: 'Invites you to a group video call', answer: 'Answer', decline: 'Decline', join: 'Join', read: 'Mark as read', more: '{n} new', test: 'Notifications work', testBody: 'This is how messages and calls will look.', msg: 'New message', photo: '📷 Photo', voice: '🎤 Voice message', video: '📹 Video message', clip: '🎬 Video', callLog: '📞 Call', missed: '📞 Missed call', file: '📎 File', login: 'New sign-in to your account: {label}. Open Thread to allow or deny it.' },
};

async function decryptText(d) {
  const raw = d.b && (await idbGet(`k:${d.c}:${d.e}`));
  if (!raw) return null;
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const blob = fromB64(d.b);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: new TextEncoder().encode(`m:${d.c}:${d.e}`) },
    key,
    blob.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

// close removes the notifications with this tag, those about messages up
// to `upTo` when given (newer ones stay unread). The app icon's count is
// the app's to reset: other chats may still be unread.
async function close(tag, upTo) {
  for (const n of await self.registration.getNotifications({ tag })) {
    if (upTo === undefined || !(n.data && n.data.m > upTo)) n.close();
  }
}

async function closeCall(id, group) {
  if (!id) return; // an old, unscoped end must not erase a newer call
  for (const n of await self.registration.getNotifications({ tag: group ? 'gcall' : 'call' })) {
    if (n.data?.id === id) n.close();
  }
}

async function callStatus(data) {
  if (!Number.isSafeInteger(data.c) || data.c <= 0 || typeof data.id !== 'string' || !data.id || data.id.length > 64) return false;
  try {
    const res = await fetch(`/api/chats/${data.c}/call-status?call=${encodeURIComponent(data.id)}`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const status = await res.json();
    return typeof status.ringing === 'boolean' ? status.ringing : null;
  } catch { return null; }
}

async function inactiveCall(data, L) {
  await closeCall(data.id, !!data.g);
  const existing = (await self.registration.getNotifications()).find((n) =>
    (n.tag === 'call' || n.tag === 'gcall' || n.tag === 'c' + data.c) &&
    !((n.tag === 'call' || n.tag === 'gcall') && n.data?.id === data.id));
  // Safari/Firefox require a visible notification for push. Reuse an
  // existing newer note quietly instead of replacing it with an old ring.
  if (existing) return self.registration.showNotification(existing.title, {
    body: existing.body, tag: existing.tag, icon: existing.icon, badge: existing.badge,
    data: existing.data, actions: existing.actions, requireInteraction: existing.requireInteraction, silent: true, renotify: false,
  });
  return self.registration.showNotification(L.app, { body: L.callEnded, tag: 'call-ended', silent: true,
    icon: '/icon-192.png', data: { url: '/#/c/' + data.c, c: data.c, id: data.id } });
}

// What the app left for this chat (store.ts notePush): its name, a group
// or not, and its picture. Who wrote, by the name I gave them (`names`).
const BADGE = '/badge-96.png'; // Android's status bar: drawn from its alpha
async function card(d, L) {
  const note = (await idbGet('push:' + d.c)) || {};
  const names = (await idbGet('names')) || {};
  return { note, from: (d.u && names[d.u]) || d.n || L.app };
}

async function onPush(d) {
  const lang = (await idbGet('lang')) === 'en' ? 'en' : 'ru';
  const L = TEXT[lang];
  // Silent pushes (never through Apple or Mozilla, see push.go): the chat
  // was read on another device, the call answered or declined there.
  if (d.t === 'read') return close('c' + d.c, d.id);
  if (d.t === 'callEnd') return closeCall(d.id, !!d.g);
  if (d.t === 'test') {
    return self.registration.showNotification(L.test, { body: L.testBody, tag: 'test', icon: '/icon-192.png', data: { url: '/#/settings' } });
  }
  if (d.t === 'device') {
    return self.registration.showNotification(L.app, {
      body: L.login.replace('{label}', d.label || '?'),
      tag: 'device',
      icon: '/icon-192.png',
      data: { url: '/#/settings' },
    });
  }
  if (d.t === 'call') {
    const active = await callStatus(d);
    if (active === false) return inactiveCall(d, L);
    await close('call-ended');
  }
  if (d.t === 'call' && d.g) {
    // A group call: a tap opens the chat, whose banner joins it; "Join"
    // (Chromium) joins straight away.
    const hide = await idbGet('hidePreview');
    const { note, from } = await card(d, L);
    return self.registration.showNotification(hide ? L.app : `📞 ${note.t || from}`, {
      body: hide ? L.groupCall : `${from} · ${(d.v ? L.groupCallVideo : L.groupCall).toLowerCase()}`,
      tag: 'gcall',
      renotify: true,
      vibrate: [400, 200, 400],
      icon: (!hide && note.i) || '/icon-192.png',
      badge: BADGE,
      data: { url: '/#/c/' + d.c, gcall: true, c: d.c, id: d.id },
      actions: [{ action: 'join', title: L.join }],
    });
  }
  if (d.t === 'call') {
    const hide = await idbGet('hidePreview');
    const { note } = await card(d, L);
    return self.registration.showNotification(hide ? L.app : `📞 ${note.t || d.n || L.app}`, {
      body: d.v ? L.callVideo : L.call,
      tag: 'call',
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400],
      icon: (!hide && note.i) || '/icon-192.png',
      badge: BADGE,
      data: { url: '/#/c/' + d.c, call: true, c: d.c, id: d.id },
      actions: [
        { action: 'answer', title: L.answer },
        { action: 'decline', title: L.decline },
      ],
    });
  }
  let p = null;
  try {
    p = await decryptText(d);
  } catch {
    /* no key on this device yet: generic text */
  }
  if (p && p.cl) {
    await close('call-ended');
    // Encrypted call summaries have no call id and can arrive late. Only
    // dismiss this chat's ring when its exact call is confirmed inactive.
    for (const n of await self.registration.getNotifications({ tag: 'call' })) {
      if (n.data?.c === d.c && await callStatus(n.data) === false) n.close();
    }
  }
  // App lock with hidden previews: say nothing about who or what.
  if (await idbGet('hidePreview')) {
    return self.registration.showNotification(L.app, { body: L.msg, tag: 'c' + d.c, icon: '/icon-192.png', badge: BADGE, data: { url: '/#/c/' + d.c, c: d.c, m: d.m } });
  }
  let body = L.msg;
  if (p) {
    const text = (p.t || '').replace(/\*\*|__|~~|`/g, '').replace(/^>\s?/gm, '').trim();
    const a = p.a && p.a[0];
    const missed = p.cl && (p.cl.s === 'missed' || p.cl.s === 'busy');
    body = p.cl ? (missed ? L.missed : L.callLog) : text || (!a ? L.msg : a.t === 'voice' ? L.voice : a.t === 'video' ? L.video : a.t === 'clip' ? L.clip : a.t === 'file' ? (a.ti ? `🎵 ${[a.ar, a.ti].filter(Boolean).join(' - ')}` : `📎 ${a.n || L.file}`) : L.photo);
  }
  // A dot on the app icon until the app opens and shows the real count.
  if (self.navigator.setAppBadge) self.navigator.setAppBadge().catch(() => {});
  // One notification per chat: the newest message, how many came since the
  // chat was last open, a group's title on top and "Name: text" under it.
  const { note, from } = await card(d, L);
  const prev = (await self.registration.getNotifications({ tag: 'c' + d.c }))[0];
  const n = ((prev && prev.data && prev.data.n) || 0) + 1;
  const title = (note.g && note.t) || from;
  return self.registration.showNotification(n > 1 ? `${title} · ${L.more.replace('{n}', n)}` : title, {
    body: note.g ? `${from}: ${body}` : body,
    tag: 'c' + d.c,
    renotify: true,
    icon: note.i || '/icon-192.png',
    badge: BADGE,
    timestamp: d.at || Date.now(),
    vibrate: [120, 60, 120],
    data: { url: '/#/c/' + d.c, c: d.c, m: d.m, n },
    actions: [{ action: 'read', title: L.read }],
  });
}

let pushQueue = Promise.resolve();
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    /* unreadable payload: show the generic notification */
  }
  const task = pushQueue.catch(() => {}).then(() => onPush(d));
  pushQueue = task;
  e.waitUntil(task);
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      // The call notification's buttons (here and notify.ts): a tab that
      // is ringing acts at once. Decline also goes to the server, for a
      // phone with no page awake; answer is left for a page that gets the
      // call only once it opens (call.ts reads it), and needs one in front.
      if (data.call && e.action === 'decline') {
        // The server and pages validate the exact id. An unavailable status
        // endpoint must not prevent declining or open an unwanted window.
        list.forEach((c) => c.postMessage({ t: 'call', k: 'decline', id: data.id, c: data.c }));
        return fetch('/api/calls/decline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ c: data.c, id: data.id }) }).catch(() => {});
      }
      if ((data.call && e.action === 'answer') || (data.gcall && e.action === 'join')) {
        const c = list.find((x) => 'focus' in x);
        // Spend the notification-click activation before the network wait
        // (Firefox expires it quickly). Keep the intent for a sleeping page.
        const foreground = (c ? c.focus() : self.clients.openWindow(url)).catch(() => null);
        if (await callStatus(data) === false) {
          (await foreground)?.postMessage({ t: 'open', url });
          return;
        }
        if (data.call) await idbSet('answer', { id: data.id, at: Date.now() });
        else await idbSet('gjoin', { c: data.c, id: data.id, at: Date.now() });
        await foreground;
        // Also include the page just opened above: its initial offer may
        // already have arrived before the status check or IDB write finished.
        for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
          client.postMessage(data.call ? { t: 'call', k: 'answer', id: data.id, c: data.c } : { t: 'gjoin', c: data.c });
        }
        return;
      }
      // "Mark as read": the server learns it as if the chat were opened up to
      // this message (the other devices' notifications close too), no app.
      // Not marked (offline, signed out): the notification comes back.
      if (e.action === 'read' && data.c) {
        const n = e.notification;
        return fetch(`/api/chats/${data.c}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: data.m }) })
          .then((res) => res.ok, () => false)
          .then((ok) =>
            ok
              ? self.registration.getNotifications().then((left) => !left.length && self.navigator.clearAppBadge && self.navigator.clearAppBadge().catch(() => {}))
              : self.registration.showNotification(n.title, { body: n.body, tag: n.tag, icon: n.icon, badge: n.badge, data: n.data, actions: n.actions }),
          );
      }
      for (const c of list) {
        if ('focus' in c) {
          // An open app routes in place: a navigation would reload it, and
          // iOS home-screen apps lose the microphone permission on each one.
          // An app too old to answer is navigated as before.
          const routed = new Promise((ok) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = () => ok(true);
            c.postMessage({ t: 'open', url }, [ch.port2]);
            setTimeout(() => ok(false), 500);
          });
          return Promise.all([c.focus(), routed.then((done) => done || c.navigate(url).catch(() => {}))]);
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

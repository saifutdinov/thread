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

function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const TEXT = {
  ru: { app: 'Нитка', call: 'Входящий звонок', callVideo: 'Входящий видеозвонок', msg: 'Новое сообщение', photo: '📷 Фото', voice: '🎤 Голосовое сообщение', video: '📹 Видеосообщение', clip: '🎬 Видео', callLog: '📞 Звонок', missed: '📞 Пропущенный звонок', file: '📎 Файл', login: 'Новый вход в аккаунт: {label}. Откройте Нитку, чтобы разрешить или запретить.' },
  en: { app: 'Thread', call: 'Incoming call', callVideo: 'Incoming video call', msg: 'New message', photo: '📷 Photo', voice: '🎤 Voice message', video: '📹 Video message', clip: '🎬 Video', callLog: '📞 Call', missed: '📞 Missed call', file: '📎 File', login: 'New sign-in to your account: {label}. Open Thread to allow or deny it.' },
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

async function onPush(d) {
  const lang = (await idbGet('lang')) === 'en' ? 'en' : 'ru';
  const L = TEXT[lang];
  if (d.t === 'device') {
    return self.registration.showNotification(L.app, {
      body: L.login.replace('{label}', d.label || '?'),
      tag: 'device',
      icon: '/icon-192.png',
      data: { url: '/#/settings' },
    });
  }
  if (d.t === 'call') {
    const hide = await idbGet('hidePreview');
    return self.registration.showNotification(hide ? L.app : `📞 ${d.n || L.app}`, {
      body: d.v ? L.callVideo : L.call,
      tag: 'call',
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400],
      icon: '/icon-192.png',
      data: { url: '/#/c/' + d.c },
    });
  }
  // App lock with hidden previews: say nothing about who or what.
  if (await idbGet('hidePreview')) {
    return self.registration.showNotification(L.app, { body: L.msg, tag: 'c' + d.c, icon: '/icon-192.png', data: { url: '/#/c/' + d.c } });
  }
  let body = L.msg;
  try {
    const p = await decryptText(d);
    if (p) {
      const text = (p.t || '').replace(/\*\*|__|~~|`/g, '').replace(/^>\s?/gm, '').trim();
      const a = p.a && p.a[0];
      const missed = p.cl && (p.cl.s === 'missed' || p.cl.s === 'busy');
      body = p.cl ? (missed ? L.missed : L.callLog) : text || (!a ? L.msg : a.t === 'voice' ? L.voice : a.t === 'video' ? L.video : a.t === 'clip' ? L.clip : a.t === 'file' ? `📎 ${a.n || L.file}` : L.photo);
    }
  } catch {
    /* no key on this device yet: generic text */
  }
  return self.registration.showNotification(d.n || L.app, {
    body,
    tag: 'c' + d.c,
    renotify: true,
    icon: '/icon-192.png',
    data: { url: '/#/c/' + d.c },
  });
}

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    /* unreadable payload: show the generic notification */
  }
  e.waitUntil(onPush(d));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          // An open app routes in place: a navigation would reload it, and
          // iOS home-screen apps lose the microphone permission on each one.
          c.postMessage({ t: 'open', url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

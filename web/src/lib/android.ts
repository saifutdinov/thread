import { effect } from '@preact/signals';
import { call, hangup } from './call';
import { groupCall, leave } from './group';
import { idbGet, idbKeys, idbSet, watchIdb } from './idb';
import { toB64 } from './crypto';
import { nativeApp, notifPermission } from './pwa';

// The Android app (android/) shows pushes without a page, so it keeps its
// own copy of what sw.js reads from IndexedDB: the chat keys, each chat's
// name and picture, my names for people, the language and hidden previews.
// Same device, same trust; the app keeps the copy encrypted by the system's
// keystore. Bytes travel as { $b: base64 }.
const KEPT = /^(k:\d+:\d+|push:\d+|names|lang|hidePreview|\*)$/;

const plain = (v: unknown) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? { $b: toB64(new Uint8Array(v as ArrayBuffer)) } : v);

export async function startAndroid() {
  const app = nativeApp;
  if (!app?.keep) return;
  const keep = app.keep.bind(app);
  watchIdb((k, v) => KEPT.test(k) && keep(k, plain(v)));

  // Notifications off in Android's settings: Settings says so.
  void app.notificationsOn?.().then((on) => (notifPermission.value = on ? 'granted' : 'denied'));

  // A call holds the microphone in a foreground service, so it goes on with
  // the screen off or another app in front. Not while it only rings; the
  // app shows itself over the lock screen while either lasts.
  effect(() => {
    const c = call.value;
    const g = groupCall.value;
    const on = (!!c && c.phase !== 'incoming') || (!!g && g.phase !== 'incoming');
    const ringing = c?.phase === 'incoming' || g?.phase === 'incoming';
    app.callState?.(on, !!(c ? !c.camOff : g && !g.camOff), ringing);
  });
  // A ring this page shows itself (in front, from the push's full-screen
  // window or opened by hand): the app's ringing notification goes.
  const taken = () => {
    if (document.visibilityState !== 'visible') return;
    if (call.value?.phase === 'incoming') app.clear('call');
    if (groupCall.value?.phase === 'incoming') app.clear('gcall');
  };
  effect(taken);
  document.addEventListener('visibilitychange', taken);

  // Taps on the app's notifications: the same messages sw.js posts, and the
  // same notes it leaves for a page that gets the call only once it opens.
  app.onMessage?.(async (m) => {
    // "End call" on the app's ongoing call notification.
    if (m.t === 'hangup') {
      if (call.value) hangup();
      else if (groupCall.value) void leave();
      return;
    }
    if (m.t === 'call' && m.k === 'answer') await idbSet('answer', { id: m.id, at: Date.now() });
    if (m.t === 'gjoin') await idbSet('gjoin', { c: m.c, id: m.id, at: Date.now() });
    navigator.serviceWorker?.dispatchEvent(new MessageEvent('message', { data: m }));
  });

  // Everything kept so far, for an app installed over an existing session
  // or a copy lost with the app's data.
  for (const k of (await idbKeys()).filter((k) => KEPT.test(k))) keep(k, plain(await idbGet(k)));
}

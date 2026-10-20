import { signal } from '@preact/signals';
import { isIOS, standalone } from './pwa';

// Hash routes: '' (chat list), c/<id>, c/<id>/info, settings, new,
// i/<secret> (invite), f/<secret> (invite for someone who already has an
// account: sign in only), r/<secret> (recovery link).
// Real history entries, so the phone's back button closes what was opened.

export interface Route {
  name: 'list' | 'chat' | 'info' | 'settings' | 'new' | 'invite' | 'recover';
  id?: number;
  secret?: string;
  friend?: boolean;
}

export function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'c' && Number(p[1]) > 0) return { name: p[2] === 'info' ? 'info' : 'chat', id: Number(p[1]) };
  if ((p[0] === 'i' || p[0] === 'f') && p[1]) return { name: 'invite', secret: p[1], friend: p[0] === 'f' || undefined };
  if (p[0] === 'r' && p[1]) return { name: 'recover', secret: p[1] };
  if (p[0] === 'settings' || p[0] === 'new') return { name: p[0] };
  return { name: 'list' };
}

export const route = signal<Route>(parse(location.hash));
const sync = () => (route.value = parse(location.hash));
window.addEventListener('popstate', sync);
window.addEventListener('hashchange', sync);

// iOS home-screen apps drop the microphone and camera permission on every
// URL change, a hash included (WebKit bug 215884): there routes live in
// memory only. Such apps have no back button to serve anyway.
const inMemory = () => isIOS && standalone.value;

// Entries pushed by the app carry state, so back() knows it can pop one
// without leaving the app (e.g. after opening a deep link from a push).
export function go(path: string) {
  if (inMemory()) route.value = parse('#/' + path);
  else {
    history.pushState({ app: true }, '', '#/' + path);
    sync();
  }
}

export function replace(path: string) {
  if (inMemory()) route.value = parse('#/' + path);
  else {
    history.replaceState(history.state, '', '#/' + path);
    sync();
  }
}

// A tapped notification opens its chat in place (see sw.js): navigating
// would reload the app.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.t === 'open') go(String(e.data.url).split('#/')[1] ?? '');
});

export function back(fallback = '') {
  if (history.state?.app) history.back();
  else replace(fallback);
}

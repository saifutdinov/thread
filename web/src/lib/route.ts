import { signal } from '@preact/signals';

// Hash routes: '' (chat list), c/<id>, c/<id>/info, settings, new,
// i/<secret> (invite), r/<secret> (recovery link).
// Real history entries, so the phone's back button closes what was opened.

export interface Route {
  name: 'list' | 'chat' | 'info' | 'settings' | 'new' | 'invite' | 'recover';
  id?: number;
  secret?: string;
}

export function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'c' && Number(p[1]) > 0) return { name: p[2] === 'info' ? 'info' : 'chat', id: Number(p[1]) };
  if (p[0] === 'i' && p[1]) return { name: 'invite', secret: p[1] };
  if (p[0] === 'r' && p[1]) return { name: 'recover', secret: p[1] };
  if (p[0] === 'settings' || p[0] === 'new') return { name: p[0] };
  return { name: 'list' };
}

export const route = signal<Route>(parse(location.hash));
const sync = () => (route.value = parse(location.hash));
window.addEventListener('popstate', sync);
window.addEventListener('hashchange', sync);

// Entries pushed by the app carry state, so back() knows it can pop one
// without leaving the app (e.g. after opening a deep link from a push).
export function go(path: string) {
  history.pushState({ app: true }, '', '#/' + path);
  sync();
}

export function replace(path: string) {
  history.replaceState(history.state, '', '#/' + path);
  sync();
}

export function back(fallback = '') {
  if (history.state?.app) history.back();
  else replace(fallback);
}

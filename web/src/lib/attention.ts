// The tab title and the app icon carry the unread count, and the title
// tells when a call is ringing: visible from another tab or the dock.
import { effect } from '@preact/signals';
import { call } from './call';
import { chats } from './store';

const base = document.title;

effect(() => {
  const n = chats.value.reduce((s, c) => s + c.unread, 0);
  const ringing = call.value?.phase === 'incoming';
  document.title = (ringing ? '📞 ' : '') + (n ? `(${n}) ` : '') + base;
  if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
});

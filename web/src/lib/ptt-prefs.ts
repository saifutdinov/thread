import { signal } from '@preact/signals';
import { remember, remembered } from './devices';
import { DEFAULT_HOTKEY, parseHotkey, type Hotkey } from './hotkey';
function saved() {
  try {
    return parseHotkey(JSON.parse(remembered('talkHotkey')));
  } catch {
    return null;
  }
}
export const talkHotkey = signal<Hotkey>(saved() ?? DEFAULT_HOTKEY);
export const globalTalk = signal(remembered('globalTalk') === '1');
export const talkCapture = signal(false);
export const companion = signal<'missing' | 'available' | 'ready' | 'error' | 'busy'>('missing');
export const setTalkHotkey = (value: Hotkey) => {
  const b = parseHotkey(value);
  if (b) {
    talkHotkey.value = b;
    remember('talkHotkey', JSON.stringify(b));
  }
};
export const setGlobalTalk = (value: boolean) => {
  globalTalk.value = value;
  remember('globalTalk', value ? '1' : '0');
};
export function probeCompanion() {
  window.postMessage({ source: 'thread-ptt', type: 'probe' }, location.origin);
}
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || e.data?.source !== 'thread-ptt-extension') return;
  if (['available', 'ready', 'error', 'busy'].includes(e.data.status)) companion.value = e.data.status;
});

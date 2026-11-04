import { signal } from '@preact/signals';

// Their voice in a 1:1 call is set for that call only: the next person
// starts at full. Compared by id, since the call screen can mount again in
// the middle of a call (the app lock).
export const voiceVolume = signal(1);
let voiceOf = '';
export function voiceForCall(id: string) {
  if (id === voiceOf) return;
  voiceOf = id;
  voiceVolume.value = 1;
}

// A call's menu opens from the keyboard on a focused tile or name: Enter,
// the menu key or Shift+F10, at the middle of that element. A key pressed
// on a control inside stays that control's.
export function menuKey(open: (x: number, y: number) => void) {
  return (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    open(r.left + r.width / 2, r.top + r.height / 2);
  };
}

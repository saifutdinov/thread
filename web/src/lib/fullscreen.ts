import { signal } from '@preact/signals';

// The whole page goes full screen, not the stream: a <dialog> cannot be the
// fullscreen element, and the call's modal dialog stays on top of the page,
// with its menus. iPhones have no such API: a stream there fills the call's
// window only.
export const fullscreen = signal(false);
export const canFullscreen = !!document.fullscreenEnabled;
document.addEventListener('fullscreenchange', () => (fullscreen.value = !!document.fullscreenElement));

// Only the page: a video in the player has a full screen of its own.
const leave = () => {
  if (document.fullscreenElement === document.documentElement) document.exitFullscreen().catch(() => {});
};

// Entering takes a moment, and the reason for it can end meanwhile: a second
// click, the sharer stopping. Without an element yet there is nothing to
// leave, so the request looks at what is wanted when it lands.
let wanted = false;
export function setFullscreen(on: boolean) {
  wanted = on;
  if (!on) return leave();
  document.documentElement.requestFullscreen?.().then(() => wanted || leave(), () => {});
}

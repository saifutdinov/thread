import { signal } from '@preact/signals';
import { t } from './i18n';

// The cameras, microphones and speakers this device has, so pickers show up
// only when there is a choice. Browsers reveal the full list (and labels)
// once a camera or microphone permission is granted: refresh after that.
export const devices = signal<MediaDeviceInfo[]>([]);

export async function refreshDevices() {
  devices.value = (await navigator.mediaDevices?.enumerateDevices().catch(() => null)) ?? [];
}
navigator.mediaDevices?.addEventListener('devicechange', () => void refreshDevices());

// Windows adds a virtual "communications" entry next to "default".
const real = (kind: MediaDeviceKind) => devices.value.filter((d) => d.kind === kind && d.deviceId !== 'communications');

export const cameras = () => real('videoinput');
export const microphones = () => real('audioinput');
// Output choice exists only where the browser can route an element's sound
// (desktop Chrome, Edge, Firefox, Safari 18.4+ on Mac). Phones route by
// themselves: Android through the microphone choice, iOS not at all.
export const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
export const speakers = () => (canPickOutput ? real('audiooutput') : []);

// deviceName: Chrome on Android names its audio routes in English; the
// earpiece and the speakerphone are what people look for in a call.
export function deviceName(d: MediaDeviceInfo, i: number): string {
  const l = d.label;
  if (/^speakerphone$/i.test(l)) return t('call.audio.speakerphone');
  if (/earpiece/i.test(l)) return t('call.audio.earpiece');
  if (/^wired headset$/i.test(l)) return t('call.audio.wired');
  return l || t('call.audio.device', { n: i + 1 });
}

// Choices are remembered per device: device ids are stable per site.
export function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: just not remembered */
  }
}

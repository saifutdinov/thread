import { effect, signal } from '@preact/signals';
import { lang, t } from './i18n';
import { idbSet } from './idb';

export type Theme = 'system' | 'light' | 'dark';

function load<T extends string>(k: string, allowed: readonly T[], def: T): T {
  try {
    const v = localStorage.getItem(k) as T | null;
    return v && allowed.includes(v) ? v : def;
  } catch {
    return def;
  }
}

function save(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: the preference just won't persist */
  }
}

export const theme = signal<Theme>(load('theme', ['system', 'light', 'dark'] as const, 'system'));
// Text scale in percent of the browser's own font size, so the OS setting
// still applies on top.
export const textSize = signal(Number(load('textSize', ['90', '100', '115', '130'] as const, '100')));

// The look of the app (data-design on <html>, styles.css): the new one or
// the classic Telegram-like one; and the chat background (data-wall). Both
// per device.
export const DESIGNS = ['fresh', 'classic'] as const;
export type Design = (typeof DESIGNS)[number];
export const DEFAULT_DESIGN: Design = 'classic'; // Thread keeps its look; "New" is a choice in Settings
export const design = signal<Design>(load('design', DESIGNS, DEFAULT_DESIGN));
export const WALLPAPERS = ['theme', 'aurora', 'sunset', 'ocean', 'mint', 'doodles', 'photo'] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];
export const wallpaper = signal<Wallpaper>(load('wallpaper', WALLPAPERS, 'theme'));

// The call's big picture: the whole of it (black bars where the shapes
// differ) or cropped to fill the screen.
export const callFit = signal(load('callFit', ['contain', 'cover'] as const, 'contain'));

// Link previews are opt-in: the server fetches the page, so it learns the link.
export const linkPreviews = signal(load('linkPreviews', ['on', 'off'] as const, 'off') === 'on');

const dark = matchMedia('(prefers-color-scheme: dark)');
const systemDark = signal(dark.matches);
dark.addEventListener('change', () => (systemDark.value = dark.matches));

export function initPrefs() {
  effect(() => {
    const mode = theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value;
    document.documentElement.dataset.theme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#17212b' : '#ffffff');
    save('theme', theme.value);
  });
  effect(() => {
    document.documentElement.style.fontSize = textSize.value + '%';
    save('textSize', String(textSize.value));
  });
  effect(() => save('linkPreviews', linkPreviews.value ? 'on' : 'off'));
  effect(() => save('callFit', callFit.value));
  effect(() => {
    document.documentElement.dataset.design = design.value;
    save('design', design.value);
  });
  effect(() => {
    document.documentElement.dataset.wall = wallpaper.value;
    save('wallpaper', wallpaper.value);
  });
  effect(() => {
    document.documentElement.lang = lang.value;
    document.title = t('app.name');
    save('lang', lang.value);
    idbSet('lang', lang.value).catch(() => {});
  });
}

// The chat background's own photo: shrunk like a sent photo, kept in this
// device's IndexedDB and shown through a CSS variable (styles.css). The
// drawn backgrounds need nothing here.
import { idbGet, idbSet } from './idb';
import { prepareImage } from './image';
import { wallpaper } from './prefs';

const KEY = 'wallPhoto';
let url = '';

function show(blob: Blob | undefined) {
  if (url) URL.revokeObjectURL(url);
  url = blob ? URL.createObjectURL(blob) : '';
  document.documentElement.style.setProperty('--wall-photo', url ? `url("${url}")` : 'none');
}

// loadWallPhoto runs at start: a photo gone (the device was signed out,
// which clears IndexedDB) puts the theme's background back.
export async function loadWallPhoto() {
  if (wallpaper.value !== 'photo') return;
  const blob = await idbGet<Blob>(KEY).catch(() => undefined);
  if (blob) show(blob);
  else wallpaper.value = 'theme';
}

export async function setWallPhoto(file: File) {
  const { blob } = await prepareImage(file);
  await idbSet(KEY, blob);
  show(blob);
  wallpaper.value = 'photo';
}

export const hasWallPhoto = async () => !!(await idbGet<Blob>(KEY).catch(() => undefined));

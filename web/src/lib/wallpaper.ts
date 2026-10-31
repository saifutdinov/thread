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

// loadWallPhoto runs at start, whichever background is chosen: the photo
// is then ready the moment its tile is picked again. One gone for good
// (the device was signed out, which clears IndexedDB) puts the theme's
// background back; a read that failed changes nothing.
export async function loadWallPhoto() {
  let blob: Blob | undefined;
  try {
    blob = await idbGet<Blob>(KEY);
  } catch {
    return;
  }
  if (blob) show(blob);
  else if (wallpaper.value === 'photo') wallpaper.value = 'theme';
}

// An animated GIF is kept as it is (prepareImage does not redraw it): a
// huge one is refused rather than stored.
const MAX_GIF = 8 << 20;

// setWallPhoto throws 'image' for a picture that cannot be used, 'save'
// when the device has no room for it.
export async function setWallPhoto(file: File) {
  let blob: Blob;
  try {
    ({ blob } = await prepareImage(file));
  } catch {
    throw new Error('image');
  }
  if (blob.type === 'image/gif' && blob.size > MAX_GIF) throw new Error('image');
  try {
    await idbSet(KEY, blob);
  } catch {
    throw new Error('save');
  }
  show(blob);
  wallpaper.value = 'photo';
}

export const hasWallPhoto = async () => !!(await idbGet<Blob>(KEY).catch(() => undefined));

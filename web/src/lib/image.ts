// Images are prepared in the browser (the server only sees ciphertext):
// orientation applied, scaled to 2560 px, metadata (EXIF/GPS) dropped by
// re-encoding, plus a tiny blurred preview that rides inside the message.
// Videos only get the preview and their size and length, see prepareVideo.

const MAX_SIDE = 2560;

export interface Prepared {
  blob: Blob;
  mime: string;
  w: number;
  h: number;
  th: string;
}

let webp: boolean | undefined;
const canEncodeWebp = () =>
  (webp ??= document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'));

function canvasFor(img: HTMLImageElement, w: number, h: number, fill: boolean) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  if (fill) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

export async function prepareImage(file: File): Promise<Prepared> {
  const url = URL.createObjectURL(file);
  try {
    // <img> applies EXIF orientation when drawn to a canvas in every
    // current browser, which createImageBitmap options do not guarantee.
    const img = new Image();
    img.src = url;
    await img.decode();
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error('image');
    const ts = 24 / Math.max(w0, h0);
    const th = canvasFor(img, Math.max(1, Math.round(w0 * ts)), Math.max(1, Math.round(h0 * ts)), true).toDataURL(
      'image/jpeg',
      0.6,
    );
    if (file.type === 'image/gif') return { blob: file, mime: 'image/gif', w: w0, h: h0, th };

    const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.round(w0 * s);
    const h = Math.round(h0 * s);
    const alpha = file.type === 'image/png' || file.type === 'image/webp';
    const mime = canEncodeWebp() ? 'image/webp' : alpha ? 'image/png' : 'image/jpeg';
    const canvas = canvasFor(img, w, h, mime === 'image/jpeg');
    const blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), mime, 0.85),
    );
    return { blob, mime: blob.type || mime, w, h, th };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface PreparedVideo {
  w: number;
  h: number;
  d: number;
  th: string;
}

const once = (el: HTMLElement, ok: string, ms: number) =>
  new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('video')), ms);
    el.addEventListener(ok, () => (clearTimeout(timer), res()), { once: true });
    el.addEventListener('error', () => (clearTimeout(timer), rej(new Error('video'))), { once: true });
  });

// prepareVideo reads a gallery video's size, length and a first-frame
// preview. The file itself goes out as it is: re-encoding a video in the
// browser is slow and drains the battery. Throws when this browser cannot
// decode it (HEVC in Chrome, say): the caller sends it as a file instead.
export async function prepareVideo(file: File): Promise<PreparedVideo> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    const meta = once(v, 'loadedmetadata', 8000);
    v.src = url;
    await meta;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) throw new Error('video');
    const d = Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0;
    let th = '';
    try {
      // iOS loads frames only once playback starts; muted play is allowed.
      const frame = once(v, 'seeked', 3000);
      await v.play().catch(() => {});
      v.pause();
      v.currentTime = Math.min(0.1, d / 2000);
      await frame;
      const s = 24 / Math.max(w, h);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(h * s));
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      th = c.toDataURL('image/jpeg', 0.6);
    } catch {
      /* no preview: the player shows a plain tile */
    }
    return { w, h, d, th };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

async function decoded(blob: Blob): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  try {
    await img.decode();
  } finally {
    URL.revokeObjectURL(img.src);
  }
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('image');
  return img;
}

// prepareAvatar crops the middle square to 256 px: small enough to ride
// sealed in the database for every chat the person is in.
export async function prepareAvatar(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const img = await decoded(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
  const mime = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), mime, 0.85));
  return new Uint8Array(await blob.arrayBuffer());
}

// shrink turns a picture into a small JPEG data URL (link preview cards).
export async function shrink(blob: Blob, max: number): Promise<string> {
  const img = await decoded(blob);
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  return canvasFor(img, Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s), true).toDataURL('image/jpeg', 0.7);
}

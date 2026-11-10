// Images are prepared in the browser (the server only sees ciphertext):
// orientation applied, scaled to 2560 px in halving steps, metadata
// (EXIF/GPS) dropped by re-encoding, plus a tiny blurred preview that
// rides inside the message.
// Videos only get the preview and their size and length, see prepareVideo.

const MAX_SIDE = 2560;
// HD: the original when it is a JPEG this size or less (only its metadata
// removed, stripJpeg below), else re-encoded large and nearly lossless.
const HD_SIDE = 4096;
const HD_ORIGINAL = 10 << 20;

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


// scaleSteps lists the sizes to draw through when shrinking. Browsers
// filter one big step poorly (Safari reads few source pixels: jagged edges,
// rippling patterns), so halve until the last step is under 2x.
export function scaleSteps(w0: number, h0: number, w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  while (w0 > 2 * w && h0 > 2 * h) {
    w0 = Math.round(w0 / 2);
    h0 = Math.round(h0 / 2);
    out.push([w0, h0]);
  }
  out.push([w, h]);
  return out;
}

type Source = HTMLImageElement | HTMLCanvasElement;
const sizeOf = (s: Source) => (s instanceof HTMLImageElement ? [s.naturalWidth, s.naturalHeight] : [s.width, s.height]);

// canvasFor draws src (or its crop box) at w x h through scaleSteps.
function canvasFor(src: Source, w: number, h: number, fill: boolean, crop?: number[]) {
  let box = crop ?? [0, 0, ...sizeOf(src)];
  let from = src;
  for (const [cw, ch] of scaleSteps(box[2], box[3], w, h)) {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d')!;
    if (fill) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(from, box[0], box[1], box[2], box[3], 0, 0, cw, ch);
    if (from !== src) (from as HTMLCanvasElement).width = 0; // iOS caps the memory all canvases share
    from = c;
    box = [0, 0, cw, ch];
  }
  return from as HTMLCanvasElement;
}

const encode = (c: HTMLCanvasElement, mime: string, quality: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), mime, quality));

const thumb = (src: Source) => {
  const [w, h] = sizeOf(src);
  const s = 24 / Math.max(w, h);
  return canvasFor(src, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)), true).toDataURL('image/jpeg', 0.6);
};

// prepareImage: a photo as it goes out. Usually 2560 px at quality 0.92,
// which keeps fine detail and text crisp; with HD the original pixels.
export async function prepareImage(file: File, hd = false): Promise<Prepared> {
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
    if (file.type === 'image/gif') return { blob: file, mime: 'image/gif', w: w0, h: h0, th: thumb(img) };

    if (hd && file.type === 'image/jpeg' && file.size <= HD_ORIGINAL) {
      const stripped = stripJpeg(new Uint8Array(await file.arrayBuffer()));
      if (stripped) return { blob: new Blob([stripped], { type: 'image/jpeg' }), mime: 'image/jpeg', w: w0, h: h0, th: thumb(img) };
    }
    const s = Math.min(1, (hd ? HD_SIDE : MAX_SIDE) / Math.max(w0, h0));
    const w = Math.round(w0 * s);
    const h = Math.round(h0 * s);
    const alpha = file.type === 'image/png' || file.type === 'image/webp';
    const mime = canEncodeWebp() ? 'image/webp' : alpha ? 'image/png' : 'image/jpeg';
    const canvas = canvasFor(img, w, h, mime === 'image/jpeg');
    const blob = await encode(canvas, mime, hd ? 0.95 : 0.92);
    return { blob, mime: blob.type || mime, w, h, th: thumb(canvas) };
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
  const crop = [(img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side];
  const mime = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
  const blob = await encode(canvasFor(img, 256, 256, mime === 'image/jpeg', crop), mime, 0.85);
  return new Uint8Array(await blob.arrayBuffer());
}

// shrink turns a picture into a small JPEG data URL (link preview cards).
export async function shrink(blob: Blob, max: number): Promise<string> {
  const img = await decoded(blob);
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  return canvasFor(img, Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s), true).toDataURL('image/jpeg', 0.7);
}

// stripJpeg: a JPEG with its pixels untouched and its metadata gone, for a
// photo sent in original quality (HD), see prepareImage. Re-encoding loses detail; this only
// drops segments: EXIF (place, time, camera, an embedded thumbnail), XMP,
// IPTC, comments, and whatever a phone appends after the image (depth maps,
// extra pictures). Kept: JFIF, the colour profile, and the orientation, as a
// minimal EXIF of its own, so the photo is not shown on its side.
// null: not a JPEG this can read; the caller re-encodes instead.
export function stripJpeg(src: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (src.length < 4 || src[0] !== 0xff || src[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [src.subarray(0, 2)];
  let orientation = 1;
  let i = 2;
  for (;;) {
    if (i + 4 > src.length || src[i] !== 0xff) return null;
    while (src[i + 1] === 0xff && i + 4 < src.length) i++; // fill bytes before a marker
    const marker = src[i + 1];
    if (marker === 0x00 || marker === 0xff) return null;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return null; // no image data before
    const len = (src[i + 2] << 8) | src[i + 3];
    if (len < 2 || i + 2 + len > src.length) return null;
    const seg = src.subarray(i, i + 2 + len);
    const body = seg.subarray(4);
    if (marker === 0xda) {
      // The scans, through the end of the image: in entropy-coded data an FF
      // is always followed by 00 or a restart marker, so FF D9 is the end.
      let end = -1;
      for (let j = i + 2 + len; j + 1 < src.length; j++) {
        if (src[j] === 0xff && src[j + 1] === 0xd9) {
          end = j + 2;
          break;
        }
      }
      if (end < 0) return null;
      // After JFIF when there is one, as JFIF wants to come first.
      if (orientation !== 1) parts.splice(parts[1]?.[1] === 0xe0 ? 2 : 1, 0, exifOrientation(orientation));
      parts.push(src.subarray(i, end));
      break;
    }
    if (marker === 0xe1 && startsWith(body, 'Exif\0\0')) orientation = readOrientation(body.subarray(6)) ?? 1;
    if (marker === 0xe0 && startsWith(body, 'JFIF\0') && body.length >= 14) {
      // JFIF's header only: its optional thumbnail may show the picture before a crop.
      const head = new Uint8Array([0xff, 0xe0, 0, 16, ...body.subarray(0, 14)]);
      head[16] = head[17] = 0;
      parts.push(head);
    } else if (
      !(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe // not an APPn, not a comment
        ? true
        : (marker === 0xe2 && startsWith(body, 'ICC_PROFILE\0')) || // colours
          (marker === 0xee && startsWith(body, 'Adobe')) // how to read the colours
    )
      parts.push(seg);
    i += 2 + len;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function startsWith(b: Uint8Array, s: string): boolean {
  if (b.length < s.length) return false;
  for (let k = 0; k < s.length; k++) if (b[k] !== s.charCodeAt(k)) return false;
  return true;
}

// The Orientation tag (0x0112) of IFD0 in a TIFF block, 1..8, or null.
function readOrientation(t: Uint8Array): number | null {
  if (t.length < 8) return null;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const u16 = (o: number) => (o + 2 > t.length ? -1 : le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) => (o + 4 > t.length ? -1 : le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);
  const ifd = u32(4);
  const n = u16(ifd);
  if (ifd < 0 || n < 0) return null;
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

// A minimal EXIF segment holding only the orientation (big-endian TIFF, one
// IFD with one SHORT entry).
function exifOrientation(o: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
  const body = [...'Exif\0\0'].map((c) => c.charCodeAt(0)).concat(tiff);
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}

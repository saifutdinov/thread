// Call effects: drawn over the local camera picture before it is sent, so
// the other side, the server and the encryption just see video. A face
// detector (MediaPipe BlazeFace, loaded on first use, see face.ts) finds
// the head; overlays are emoji and simple shapes on a 2D canvas.
// Limit: BlazeFace gives eyes, nose, mouth and ears only; expressions
// (open mouth, a kiss) need MediaPipe's FaceLandmarker in the same engine.

export type EffectId = 'crown' | 'halo' | 'ears' | 'glasses' | 'orbit' | 'hearts' | 'confetti' | 'snow' | 'bw' | 'sepia' | 'warm';

// The picker shows these in order. `face`: drawn where the head is.
export const EFFECTS: { id: EffectId; icon: string; face?: boolean }[] = [
  { id: 'crown', icon: '👑', face: true },
  { id: 'halo', icon: '😇', face: true },
  { id: 'ears', icon: '🐱', face: true },
  { id: 'glasses', icon: '🕶️', face: true },
  { id: 'orbit', icon: '💞', face: true },
  { id: 'hearts', icon: '💖' },
  { id: 'confetti', icon: '🎉' },
  { id: 'snow', icon: '❄️' },
  { id: 'bw', icon: '🖤' },
  { id: 'sepia', icon: '🟤' },
  { id: 'warm', icon: '🌅' },
];

// ---------- the head ----------

// Head: the point between the eyes, the tilt of the eye line (radians,
// clockwise in the picture) and the distance between the eyes (px), which
// sizes everything drawn on the head.
export interface Head {
  x: number;
  y: number;
  roll: number;
  size: number;
}

// headFrom reads BlazeFace keypoints (normalized; left eye as seen, then
// right eye, nose, mouth, ears) for a w x h picture.
export function headFrom(kp: { x: number; y: number }[], w: number, h: number): Head | null {
  if (kp.length < 2) return null;
  const lx = kp[0].x * w;
  const ly = kp[0].y * h;
  const rx = kp[1].x * w;
  const ry = kp[1].y * h;
  return { x: (lx + rx) / 2, y: (ly + ry) / 2, roll: Math.atan2(ry - ly, rx - lx), size: Math.hypot(rx - lx, ry - ly) };
}

// follow moves a share k of the way to the new reading: the detector
// jitters a little from frame to frame, the overlay should not.
export function follow(prev: Head | null, next: Head, k: number): Head {
  if (!prev) return next;
  const m = (a: number, b: number) => a + (b - a) * k;
  return { x: m(prev.x, next.x), y: m(prev.y, next.y), roll: m(prev.roll, next.roll), size: m(prev.size, next.size) };
}

// ---------- particles ----------

export type ParticleKind = 'snow' | 'confetti' | 'hearts';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number; // rotation
  spin: number;
  size: number;
  n: number; // colour or glyph pick, 0..1
}

type Rand = () => number;

const COUNT: Record<ParticleKind, number> = { snow: 70, confetti: 60, hearts: 14 };

// spawn makes one particle: anywhere on the picture at the start, else just
// outside the edge it enters from (the top; the bottom for rising hearts).
function spawn(kind: ParticleKind, w: number, h: number, rand: Rand, anywhere: boolean): Particle {
  const s = Math.min(w, h);
  const size = kind === 'hearts' ? s * (0.06 + 0.05 * rand()) : kind === 'confetti' ? s * (0.015 + 0.015 * rand()) : s * (0.004 + 0.008 * rand());
  const speed = kind === 'hearts' ? -h * (0.1 + 0.1 * rand()) : kind === 'confetti' ? h * (0.2 + 0.15 * rand()) : h * (0.06 + 0.1 * rand());
  const y = anywhere ? rand() * h : kind === 'hearts' ? h + size : -size;
  return { x: rand() * w, y, vx: (rand() - 0.5) * s * 0.1, vy: speed, r: rand() * 6.3, spin: (rand() - 0.5) * 6, size, n: rand() };
}

export function particles(kind: ParticleKind, n: number, w: number, h: number, rand: Rand = Math.random): Particle[] {
  return Array.from({ length: n }, () => spawn(kind, w, h, rand, true));
}

// stepParticles moves every particle by dt seconds; one that left the
// picture comes back from the edge it enters from.
export function stepParticles(ps: Particle[], kind: ParticleKind, dt: number, w: number, h: number, rand: Rand = Math.random) {
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.r += p.spin * dt;
    if (p.y > h + p.size || p.y < -p.size) ps[i] = spawn(kind, w, h, rand, false);
  }
}

// ---------- drawing ----------

const FONT = 'system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

function emoji(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, size: number, rot = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.font = `${Math.round(size)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, 0, 0);
  ctx.restore();
}

// above: the point `d` eye-distances above the eyes along the head's up.
const above = (h: Head, d: number, side = 0) => ({
  x: h.x + Math.sin(h.roll) * h.size * d + Math.cos(h.roll) * h.size * side,
  y: h.y - Math.cos(h.roll) * h.size * d + Math.sin(h.roll) * h.size * side,
});

function catEar(ctx: CanvasRenderingContext2D, h: Head, side: number) {
  const s = h.size;
  const at = above(h, 1.45, side * 0.95);
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(h.roll + side * 0.35);
  const tri = (w: number, ht: number, color: string) => {
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(0, -ht);
    ctx.lineTo(w / 2, 0);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  tri(s * 0.95, s * 1.15, '#5d4037');
  tri(s * 0.55, s * 0.75, '#f8bbd0');
  ctx.restore();
}

function overlay(ctx: CanvasRenderingContext2D, id: EffectId, h: Head, t: number) {
  const s = h.size;
  switch (id) {
    case 'crown': {
      const at = above(h, 2.0);
      emoji(ctx, '👑', at.x, at.y, s * 2.3, h.roll);
      return;
    }
    case 'halo': {
      const at = above(h, 2.2);
      ctx.save();
      ctx.translate(at.x, at.y);
      ctx.rotate(h.roll);
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = s * 0.16;
      ctx.shadowColor = '#fff59d';
      ctx.shadowBlur = s * 0.6;
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 1.35, s * 0.35, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    case 'ears':
      catEar(ctx, h, -1);
      catEar(ctx, h, 1);
      return;
    case 'glasses':
      emoji(ctx, '🕶️', h.x, h.y, s * 2.2, h.roll);
      return;
    case 'orbit': {
      // Hearts circle the head; the far half of the ring is drawn smaller
      // and paler, which reads as going round behind it.
      for (let i = 0; i < 6; i++) {
        const a = t * 1.4 + (i * Math.PI * 2) / 6;
        const back = Math.sin(a);
        const at = above(h, 1.3 + back * 0.45, Math.cos(a) * 2.1);
        ctx.globalAlpha = back > 0 ? 0.55 : 1;
        emoji(ctx, '💖', at.x, at.y, s * (back > 0 ? 0.45 : 0.65), h.roll);
      }
      ctx.globalAlpha = 1;
      return;
    }
  }
}

const HEARTS = ['💖', '💕', '💗', '❤️'];

function drawParticles(ctx: CanvasRenderingContext2D, kind: ParticleKind, ps: Particle[], t: number) {
  if (kind === 'hearts') {
    for (const p of ps) emoji(ctx, HEARTS[Math.floor(p.n * HEARTS.length)], p.x + Math.sin(t * 2 + p.n * 9) * p.size * 0.4, p.y, p.size);
    return;
  }
  for (const p of ps) {
    ctx.save();
    ctx.translate(p.x, p.y);
    if (kind === 'confetti') {
      ctx.rotate(p.r);
      ctx.fillStyle = `hsl(${Math.round(p.n * 360)} 85% 60%)`;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(0, 0, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Colour filters use canvas blend modes, which every engine has (Safari's
// canvas has no ctx.filter on older versions).
function filter(ctx: CanvasRenderingContext2D, id: EffectId, w: number, h: number) {
  const fill = (mode: GlobalCompositeOperation, style: string) => {
    ctx.globalCompositeOperation = mode;
    ctx.fillStyle = style;
    ctx.fillRect(0, 0, w, h);
  };
  if (id === 'bw' || id === 'sepia') fill('saturation', '#000');
  if (id === 'sepia') fill('color', 'rgba(112, 66, 20, 0.55)');
  if (id === 'warm') fill('overlay', 'rgba(255, 140, 40, 0.4)');
  ctx.globalCompositeOperation = 'source-over';
}

// ---------- the pipeline ----------

export interface Effects {
  readonly camera: MediaStreamTrack; // the bare camera, still owned by the caller
  readonly track: MediaStreamTrack; // the picture with the effect, to send and to show
  readonly id: EffectId;
  set(id: EffectId): void;
  stop(): void; // the canvas and its track; not the camera
}

// The picture keeps the camera's shape, at most this wide.
const MAX_SIDE = 1280;

// startEffects draws `camera` with the effect on a canvas and returns the
// canvas's track. onSlow fires when this device cannot keep up.
export async function startEffects(camera: MediaStreamTrack, first: EffectId, onSlow: () => void): Promise<Effects> {
  const { detector } = await import('./face');
  const faces = await detector();

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([camera]);
  // Kept in the page, not display:none: WebKit stops decoding a hidden
  // camera preview (WebKit bug 321693).
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  document.body.append(video);
  await video.play();

  const { width = 640, height = 480 } = camera.getSettings();
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  const w = (canvas.width = Math.round(width * k));
  const h = (canvas.height = Math.round(height * k));
  const ctx = canvas.getContext('2d')!;
  const track = canvas.captureStream(30).getVideoTracks()[0];

  let id = first;
  let head: Head | null = null;
  let missed = 0;
  let lastDetect = 0;
  let last = performance.now();
  let slow = 0;
  let running = true;
  let kind: ParticleKind | null = null;
  let ps: Particle[] = [];

  const frame = () => {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (video.readyState >= 2) {
      const face = EFFECTS.find((e) => e.id === id)?.face;
      // ~15 detections a second are plenty; the overlay glides in between.
      if (face && now - lastDetect > 66) {
        lastDetect = now;
        const kp = faces.detectForVideo(video, now).detections[0]?.keypoints;
        const next = kp && headFrom(kp, w, h);
        if (next) {
          head = follow(head, next, 0.6);
          missed = 0;
        } else if (++missed > 5) head = null; // gone, not just one missed frame
      }
      ctx.drawImage(video, 0, 0, w, h);
      filter(ctx, id, w, h);
      if (face && head) overlay(ctx, id, head, now / 1000);
      const want: ParticleKind | null = id === 'snow' || id === 'confetti' || id === 'hearts' ? id : null;
      if (want !== kind) {
        kind = want;
        ps = want ? particles(want, COUNT[want], w, h) : [];
      }
      if (kind) {
        stepParticles(ps, kind, dt, w, h);
        drawParticles(ctx, kind, ps, now / 1000);
      }
      // A frame over 80 ms, again and again: the phone cannot keep up.
      slow = performance.now() - now > 80 ? slow + 1 : 0;
      if (slow > 30) {
        onSlow();
        return;
      }
    }
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(frame);
    else requestAnimationFrame(frame);
  };
  frame();

  return {
    camera,
    track,
    get id() {
      return id;
    },
    set(next: EffectId) {
      id = next;
      head = null;
    },
    stop() {
      running = false;
      track.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}

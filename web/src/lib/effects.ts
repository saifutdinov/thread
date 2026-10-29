// Call effects: drawn over the local camera picture before it is sent, so
// the other side, the server and the encryption just see video. MediaPipe's
// face landmarker (478 points and expressions) places things on the face,
// its person segmenter cuts the person out of the background; both load on
// first use (face.ts). Everything is drawn with canvas paths and gradients,
// not emoji: it looks the same on every device.

export type EffectId =
  | 'crown'
  | 'halo'
  | 'flowers'
  | 'party'
  | 'horns'
  | 'cat'
  | 'bunny'
  | 'dog'
  | 'glasses'
  | 'love'
  | 'mustache'
  | 'clown'
  | 'kiss'
  | 'fire'
  | 'orbit'
  | 'hearts'
  | 'confetti'
  | 'snow'
  | 'bw'
  | 'sepia'
  | 'warm'
  | 'cool';

export type BgId = 'blur' | 'sunset' | 'night' | 'bokeh' | 'studio';

// The picker shows these in order. `face`: drawn on the face.
export const EFFECTS: { id: EffectId; icon: string; face?: boolean }[] = [
  { id: 'crown', icon: '👑', face: true },
  { id: 'halo', icon: '😇', face: true },
  { id: 'flowers', icon: '🌸', face: true },
  { id: 'party', icon: '🥳', face: true },
  { id: 'horns', icon: '😈', face: true },
  { id: 'cat', icon: '🐱', face: true },
  { id: 'bunny', icon: '🐰', face: true },
  { id: 'dog', icon: '🐶', face: true },
  { id: 'glasses', icon: '🕶️', face: true },
  { id: 'love', icon: '😍', face: true },
  { id: 'mustache', icon: '🥸', face: true },
  { id: 'clown', icon: '🤡', face: true },
  { id: 'kiss', icon: '😘', face: true },
  { id: 'fire', icon: '🐉', face: true },
  { id: 'orbit', icon: '💞', face: true },
  { id: 'hearts', icon: '💖' },
  { id: 'confetti', icon: '🎉' },
  { id: 'snow', icon: '❄️' },
  { id: 'bw', icon: '🖤' },
  { id: 'sepia', icon: '🟤' },
  { id: 'warm', icon: '🟠' },
  { id: 'cool', icon: '🔵' },
];

export const BACKGROUNDS: { id: BgId; icon: string }[] = [
  { id: 'blur', icon: '🌫️' },
  { id: 'sunset', icon: '🌅' },
  { id: 'night', icon: '🌌' },
  { id: 'bokeh', icon: '✨' },
  { id: 'studio', icon: '⬜' },
];

// What the camera wears: one effect and one background, each optional.
export interface Look {
  effect: EffectId | null;
  bg: BgId | null;
}

// ---------- the head ----------

export interface Pt {
  x: number;
  y: number;
}

// Head: points on one face in picture pixels, left and right as seen in
// the picture. roll tilts the eye line (radians, clockwise); size is the
// distance between the eyes, the unit everything on the head is drawn in;
// open and pucker (0..1) come from the expression.
export interface Head {
  eyeL: Pt;
  eyeR: Pt;
  mid: Pt;
  top: Pt;
  chin: Pt;
  nose: Pt;
  noseBase: Pt;
  lip: Pt;
  mouth: Pt;
  mouthL: Pt;
  mouthR: Pt;
  cheekL: Pt;
  cheekR: Pt;
  sideL: Pt;
  sideR: Pt;
  roll: number;
  size: number;
  width: number;
  open: number;
  pucker: number;
}

// FaceLandmarker mesh indices: iris centres, the top of the forehead, the
// chin, the nose tip and its base, the lips, mouth corners, cheeks and the
// sides of the face. The L/R pairs are the subject's right and left, which
// is the picture's left and right in an unmirrored camera.
const LM = { eyeL: 468, eyeR: 473, top: 10, chin: 152, nose: 1, noseBase: 2, lip: 13, lipLow: 14, mouthL: 61, mouthR: 291, cheekL: 50, cheekR: 280, sideL: 234, sideR: 454 };

const avg = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

// headFrom reads one face's mesh (normalized coordinates) for a w x h
// picture. Camera frames are never mirrored here (only the self view is,
// in CSS), so the mesh's sides are the picture's; roll follows the eyes
// all the way round, also for someone lying on their side.
export function headFrom(lm: { x: number; y: number }[], w: number, h: number): Head | null {
  if (lm.length < 478) return null;
  const P = (i: number): Pt => ({ x: lm[i].x * w, y: lm[i].y * h });
  const [eyeL, eyeR, mouthL, mouthR, cheekL, cheekR, sideL, sideR] = [LM.eyeL, LM.eyeR, LM.mouthL, LM.mouthR, LM.cheekL, LM.cheekR, LM.sideL, LM.sideR].map(P);
  const lip = P(LM.lip);
  return {
    eyeL,
    eyeR,
    mid: avg(eyeL, eyeR),
    top: P(LM.top),
    chin: P(LM.chin),
    nose: P(LM.nose),
    noseBase: P(LM.noseBase),
    lip,
    mouth: avg(lip, P(LM.lipLow)),
    mouthL,
    mouthR,
    cheekL,
    cheekR,
    sideL,
    sideR,
    roll: Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x),
    size: dist(eyeL, eyeR),
    width: dist(sideL, sideR),
    open: 0,
    pucker: 0,
  };
}

// expression: how open the mouth is and how much the lips are pursed, from
// the landmarker's blendshapes.
export function expression(cats: { categoryName: string; score: number }[]): { open: number; pucker: number } {
  const score = (name: string) => cats.find((c) => c.categoryName === name)?.score ?? 0;
  return { open: score('jawOpen'), pucker: score('mouthPucker') };
}

// One Euro filter (Casiez et al., 2012): heavy smoothing while still, little
// lag when moving fast. The landmarks jitter by a pixel or two from frame
// to frame; a crown must not.
export class OneEuro {
  private x?: number;
  private t = 0;
  private dx = 0;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  constructor(minCutoff = 1.5, beta = 0.03, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }
  filter(x: number, t: number): number {
    if (this.x === undefined) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const a = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.dx += a(this.dCutoff) * ((x - this.x) / dt - this.dx);
    this.x += a(this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x);
    return this.x;
  }
}

const POINTS = ['eyeL', 'eyeR', 'mid', 'top', 'chin', 'nose', 'noseBase', 'lip', 'mouth', 'mouthL', 'mouthR', 'cheekL', 'cheekR', 'sideL', 'sideR'] as const;
const NUMBERS = ['roll', 'size', 'width', 'open', 'pucker'] as const;

const toVec = (h: Head) => [...POINTS.flatMap((k) => [h[k].x, h[k].y]), ...NUMBERS.map((k) => h[k])];
function fromVec(v: number[]): Head {
  const h = {} as Head;
  POINTS.forEach((k, i) => (h[k] = { x: v[2 * i], y: v[2 * i + 1] }));
  NUMBERS.forEach((k, i) => (h[k] = v[2 * POINTS.length + i]));
  return h;
}

// Tracker smooths each face's numbers with its own filters. Faces are
// matched left to right.
// Limit: two people swapping places swap their filters for a moment;
// match by distance if that shows.
class Tracker {
  private filters: OneEuro[][] = [];
  private shown: number[][] = [];
  private target: number[][] = [];

  // A face that comes or goes keeps the others' filters: a second face
  // flickering at the edge must not shake the first one.
  update(heads: Head[], t: number) {
    heads.sort((a, b) => a.mid.x - b.mid.x);
    this.filters.length = this.shown.length = Math.min(this.shown.length, heads.length);
    this.target = heads.map((h, i) => toVec(h).map((x, j) => ((this.filters[i] ??= [])[j] ??= new OneEuro()).filter(x, t)));
    this.target.forEach((v, i) => (this.shown[i] ??= [...v]));
  }

  clear() {
    this.filters = [];
    this.shown = [];
    this.target = [];
  }

  // heads glides the drawn faces towards the latest reading, so they move
  // every frame although the landmarker runs about 15 times a second.
  heads(dt: number): Head[] {
    const k = 1 - Math.exp(-dt * 22);
    this.shown.forEach((v, i) => v.forEach((x, j) => (v[j] = x + (this.target[i][j] - x) * k)));
    return this.shown.map(fromVec);
  }
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
  n: number; // colour or shape pick, 0..1
}

type Rand = () => number;

const COUNT: Record<ParticleKind, number> = { snow: 80, confetti: 70, hearts: 16 };

// spawn makes one particle: anywhere on the picture at the start, else just
// outside the edge it enters from (the top; the bottom for rising hearts).
function spawn(kind: ParticleKind, w: number, h: number, rand: Rand, anywhere: boolean): Particle {
  const s = Math.min(w, h);
  const size = kind === 'hearts' ? s * (0.04 + 0.04 * rand()) : kind === 'confetti' ? s * (0.015 + 0.015 * rand()) : s * (0.004 + 0.008 * rand());
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

// Puffs come out of the mouth: hearts for a kiss, flames for an open mouth.
export type PuffKind = 'heart' | 'flame';

export interface Puff extends Pt {
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  kind: PuffKind;
}

export function puff(at: Pt, kind: PuffKind, size: number, rand: Rand = Math.random): Puff {
  const a = rand() * Math.PI * 2;
  const v = size * (kind === 'flame' ? 3 + 3 * rand() : 1.5 + rand());
  return {
    x: at.x,
    y: at.y,
    vx: Math.cos(a) * v * (kind === 'flame' ? 1 : 0.6),
    vy: kind === 'heart' ? -size * (2 + 2 * rand()) : Math.sin(a) * v * 0.5 + size,
    age: 0,
    life: kind === 'flame' ? 0.5 + 0.3 * rand() : 1.2 + 0.6 * rand(),
    size,
    kind,
  };
}

// stepPuffs ages and moves the puffs, dropping the ones past their life.
export function stepPuffs(ps: Puff[], dt: number) {
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    p.age += dt;
    if (p.age >= p.life) {
      ps.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

// ---------- the background mask ----------

// maskAlpha writes the person's confidence into the alpha of an RGBA mask,
// half way from the last frame each time: the edge does not flicker.
export function maskAlpha(conf: Float32Array, prev: Float32Array, out: Uint8ClampedArray) {
  for (let i = 0; i < conf.length; i++) {
    prev[i] += (conf[i] - prev[i]) * 0.5;
    out[4 * i + 3] = Math.round(255 * prev[i]);
  }
}

// ---------- drawing ----------

type Ctx = CanvasRenderingContext2D;

// place draws in the head's own units around point p: x along the eye line,
// y towards the chin, 1 = the distance between the eyes.
function place(ctx: Ctx, h: Head, p: Pt, draw: () => void) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(h.roll);
  ctx.scale(h.size, h.size);
  draw();
  ctx.restore();
}

function heartPath(ctx: Ctx, x: number, y: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.35);
  ctx.bezierCurveTo(x - s * 0.6, y - s * 0.05, x - s * 0.35, y - s * 0.55, x, y - s * 0.22);
  ctx.bezierCurveTo(x + s * 0.35, y - s * 0.55, x + s * 0.6, y - s * 0.05, x, y + s * 0.35);
  ctx.closePath();
}

function heart(ctx: Ctx, x: number, y: number, s: number, hue = 345) {
  const g = ctx.createRadialGradient(x - s * 0.15, y - s * 0.2, s * 0.05, x, y, s * 0.6);
  g.addColorStop(0, `hsl(${hue} 100% 80%)`);
  g.addColorStop(1, `hsl(${hue} 85% 52%)`);
  heartPath(ctx, x, y, s);
  ctx.fillStyle = g;
  ctx.fill();
}

function gold(ctx: Ctx, y0: number, y1: number) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, '#fff3b0');
  g.addColorStop(0.45, '#ffd54f');
  g.addColorStop(1, '#c49000');
  return g;
}

function crown(ctx: Ctx) {
  ctx.beginPath();
  ctx.moveTo(-1, 0);
  const tips = [-1, -0.5, 0, 0.5, 1];
  tips.forEach((x, i) => {
    ctx.lineTo(x, i % 2 ? -0.55 : -0.95);
    if (i < tips.length - 1) ctx.lineTo(x + 0.25, -0.35);
  });
  ctx.lineTo(1, 0);
  ctx.closePath();
  ctx.fillStyle = gold(ctx, -0.95, 0);
  ctx.fill();
  ctx.lineWidth = 0.04;
  ctx.strokeStyle = '#8d6e00';
  ctx.stroke();
  ctx.fillStyle = gold(ctx, -0.2, 0.08);
  ctx.fillRect(-1.02, -0.18, 2.04, 0.26);
  ctx.strokeRect(-1.02, -0.18, 2.04, 0.26);
  ['#e53935', '#1e88e5', '#43a047', '#1e88e5', '#e53935'].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(-0.8 + i * 0.4, -0.05, 0.08, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  tips.forEach((x, i) => {
    ctx.beginPath();
    ctx.arc(x, i % 2 ? -0.58 : -0.98, 0.07, 0, Math.PI * 2);
    ctx.fillStyle = '#fffde7';
    ctx.fill();
  });
}

function flower(ctx: Ctx, x: number, y: number, r: number, petal: string) {
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    ctx.beginPath();
    ctx.ellipse(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85, r * 0.6, r * 0.42, a, 0, Math.PI * 2);
    ctx.fillStyle = petal;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = '#ffca28';
  ctx.fill();
}

function ear(ctx: Ctx, side: number, outer: string, inner: string, w: number, ht: number, tilt: number) {
  ctx.save();
  ctx.rotate(side * tilt);
  const tri = (k: number, color: string) => {
    ctx.beginPath();
    ctx.moveTo((-w / 2) * k, 0);
    ctx.quadraticCurveTo(-w * 0.12 * k, -ht * k * 0.7, 0, -ht * k);
    ctx.quadraticCurveTo(w * 0.12 * k, -ht * k * 0.7, (w / 2) * k, 0);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  tri(1, outer);
  tri(0.6, inner);
  ctx.restore();
}

function lens(ctx: Ctx, x: number, fill: CanvasGradient | string) {
  ctx.beginPath();
  ctx.roundRect(x - 0.42, -0.28, 0.84, 0.58, 0.24);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 0.07;
  ctx.strokeStyle = '#111';
  ctx.stroke();
}

function overlay(ctx: Ctx, id: EffectId, h: Head, t: number) {
  // Hats sit on the forehead top, a little higher the wider the face.
  const hat = (up: number, draw: () => void) => place(ctx, h, h.top, () => (ctx.translate(0, -up), draw()));
  switch (id) {
    case 'crown':
      return hat(0.15, () => (ctx.scale(1.3, 1.3), crown(ctx)));
    case 'halo':
      return hat(0.75, () => {
        ctx.shadowColor = '#fff59d';
        ctx.shadowBlur = h.size * 0.5;
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 0.15;
        ctx.beginPath();
        ctx.ellipse(0, 0, 1.25, 0.3, 0, 0, Math.PI * 2);
        ctx.stroke();
      });
    case 'flowers':
      return hat(0.05, () => {
        const colors = ['#f48fb1', '#fff', '#ce93d8', '#ffab91', '#fff', '#f48fb1', '#ce93d8'];
        colors.forEach((c, i) => {
          const a = Math.PI * (0.15 + (0.7 * i) / (colors.length - 1));
          flower(ctx, -Math.cos(a) * 1.25, 0.25 - Math.sin(a) * 0.45, 0.2, c);
        });
      });
    case 'party':
      return hat(0.1, () => {
        ctx.rotate(0.12);
        ctx.beginPath();
        ctx.moveTo(-0.6, 0);
        ctx.lineTo(0, -1.7);
        ctx.lineTo(0.6, 0);
        ctx.closePath();
        ctx.save();
        ctx.clip();
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = i % 2 ? '#29b6f6' : '#ec407a';
          ctx.fillRect(-0.7, -1.7 + i * 0.3, 1.4, 0.3);
        }
        ctx.restore();
        ctx.beginPath();
        ctx.arc(0, -1.72, 0.16, 0, Math.PI * 2);
        ctx.fillStyle = '#ffee58';
        ctx.fill();
      });
    case 'horns':
      return hat(0, () => {
        ctx.scale(1.25, 1.25);
        for (const side of [-1, 1]) {
          const g = ctx.createLinearGradient(0, 0, 0, -0.9);
          g.addColorStop(0, '#b71c1c');
          g.addColorStop(1, '#ff5252');
          ctx.beginPath();
          ctx.moveTo(side * 0.45, 0.05);
          ctx.quadraticCurveTo(side * 0.55, -0.55, side * 1.0, -0.95);
          ctx.quadraticCurveTo(side * 0.85, -0.45, side * 0.85, 0.05);
          ctx.closePath();
          ctx.fillStyle = g;
          ctx.fill();
        }
      });
    case 'cat':
      hat(-0.1, () => {
        for (const side of [-1, 1]) {
          ctx.save();
          ctx.translate(side * 0.85, 0);
          ear(ctx, side, '#6d4c41', '#f8bbd0', 0.95, 1.1, 0.3);
          ctx.restore();
        }
      });
      place(ctx, h, h.nose, () => {
        ctx.fillStyle = '#f06292';
        ctx.beginPath();
        ctx.moveTo(-0.16, -0.05);
        ctx.lineTo(0.16, -0.05);
        ctx.lineTo(0, 0.13);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 0.025;
        for (const side of [-1, 1])
          for (const k of [-1, 0, 1]) {
            ctx.beginPath();
            ctx.moveTo(side * 0.3, 0.15 + k * 0.08);
            ctx.lineTo(side * 1.25, 0.05 + k * 0.2);
            ctx.stroke();
          }
      });
      return;
    case 'bunny':
      hat(0.35, () => {
        for (const side of [-1, 1]) {
          ctx.save();
          ctx.translate(side * 0.42, 0);
          ctx.rotate(side * 0.15);
          ctx.beginPath();
          ctx.ellipse(0, -0.8, 0.28, 0.95, 0, 0, Math.PI * 2);
          ctx.fillStyle = '#fafafa';
          ctx.fill();
          ctx.beginPath();
          ctx.ellipse(0, -0.75, 0.14, 0.72, 0, 0, Math.PI * 2);
          ctx.fillStyle = '#f8bbd0';
          ctx.fill();
          ctx.restore();
        }
      });
      place(ctx, h, h.nose, () => {
        ctx.beginPath();
        ctx.ellipse(0, 0, 0.13, 0.09, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#f48fb1';
        ctx.fill();
      });
      return;
    case 'dog':
      hat(-0.25, () => {
        for (const side of [-1, 1]) {
          ctx.save();
          ctx.translate(side * 1.05, 0);
          ctx.rotate(side * -0.35);
          ctx.beginPath();
          ctx.ellipse(0, 0.55, 0.32, 0.75, 0, 0, Math.PI * 2);
          ctx.fillStyle = '#8d6e63';
          ctx.fill();
          ctx.restore();
        }
      });
      place(ctx, h, h.nose, () => {
        const g = ctx.createRadialGradient(-0.06, -0.06, 0.02, 0, 0, 0.3);
        g.addColorStop(0, '#666');
        g.addColorStop(1, '#111');
        ctx.beginPath();
        ctx.ellipse(0, 0, 0.27, 0.19, 0, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
      });
      // An open mouth sticks the tongue out, the wider the longer.
      if (h.open > 0.25)
        place(ctx, h, h.mouth, () => {
          const len = 0.25 + h.open * 0.7;
          ctx.beginPath();
          ctx.roundRect(-0.22, -0.05, 0.44, len, [0, 0, 0.22, 0.22]);
          ctx.fillStyle = '#ef5f86';
          ctx.fill();
          ctx.strokeStyle = '#c2185b';
          ctx.lineWidth = 0.03;
          ctx.beginPath();
          ctx.moveTo(0, 0.02);
          ctx.lineTo(0, len * 0.7);
          ctx.stroke();
        });
      return;
    case 'glasses':
      return place(ctx, h, h.mid, () => {
        for (const x of [-0.5, 0.5]) {
          const g = ctx.createLinearGradient(x - 0.4, -0.3, x + 0.4, 0.3);
          g.addColorStop(0, 'rgba(60, 60, 70, 0.92)');
          g.addColorStop(1, 'rgba(10, 10, 20, 0.96)');
          lens(ctx, x, g);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.lineWidth = 0.05;
          ctx.beginPath();
          ctx.moveTo(x - 0.25, -0.12);
          ctx.lineTo(x - 0.05, -0.2);
          ctx.stroke();
        }
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 0.07;
        ctx.beginPath();
        ctx.moveTo(-0.08, -0.1);
        ctx.quadraticCurveTo(0, -0.18, 0.08, -0.1);
        ctx.moveTo(-0.92, -0.12);
        ctx.lineTo(-1.15, -0.16);
        ctx.moveTo(0.92, -0.12);
        ctx.lineTo(1.15, -0.16);
        ctx.stroke();
      });
    case 'love':
      return place(ctx, h, h.mid, () => {
        for (const x of [-0.5, 0.5]) {
          heart(ctx, x, 0.02, 0.85 + Math.sin(t * 6) * 0.04);
          ctx.lineWidth = 0.05;
          ctx.strokeStyle = '#880e4f';
          ctx.stroke();
        }
      });
    case 'mustache':
      return place(ctx, h, avg(h.noseBase, h.lip), () => {
        ctx.fillStyle = '#3e2723';
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(0, -0.08);
          ctx.bezierCurveTo(side * 0.3, -0.2, side * 0.6, -0.05, side * 0.75, -0.18);
          ctx.bezierCurveTo(side * 0.8, 0.02, side * 0.45, 0.14, 0, 0.06);
          ctx.closePath();
          ctx.fill();
        }
      });
    case 'clown':
      return place(ctx, h, h.nose, () => {
        const g = ctx.createRadialGradient(-0.09, -0.1, 0.03, 0, 0, 0.3);
        g.addColorStop(0, '#ff8a80');
        g.addColorStop(1, '#d50000');
        ctx.beginPath();
        ctx.arc(0, 0, 0.28, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
      });
    case 'kiss':
      for (const c of [h.cheekL, h.cheekR])
        place(ctx, h, c, () => {
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.5);
          g.addColorStop(0, 'rgba(255, 100, 130, 0.5)');
          g.addColorStop(1, 'rgba(255, 100, 130, 0)');
          ctx.fillStyle = g;
          ctx.fillRect(-0.5, -0.5, 1, 1);
        });
      return;
    case 'orbit':
      // Hearts circle the head; the far half of the ring is drawn smaller
      // and paler, which reads as going round behind it.
      return place(ctx, h, h.top, () => {
        for (let i = 0; i < 6; i++) {
          const a = t * 1.4 + (i * Math.PI * 2) / 6;
          const back = Math.sin(a);
          ctx.globalAlpha = back > 0 ? 0.55 : 1;
          heart(ctx, Math.cos(a) * 1.6, 0.1 + back * 0.35, back > 0 ? 0.4 : 0.55);
        }
        ctx.globalAlpha = 1;
      });
  }
}

function drawPuffs(ctx: Ctx, ps: Puff[]) {
  for (const p of ps) {
    const k = p.age / p.life;
    ctx.globalAlpha = 1 - k;
    if (p.kind === 'heart') heart(ctx, p.x, p.y, p.size * (0.8 + k * 0.6));
    else {
      const r = p.size * (0.6 + k * 1.6);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, `hsla(${55 - k * 50} 100% 70% / 0.95)`);
      g.addColorStop(1, `hsla(${20 - k * 20} 100% 50% / 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawParticles(ctx: Ctx, kind: ParticleKind, ps: Particle[], t: number) {
  for (const p of ps) {
    if (kind === 'hearts') {
      heart(ctx, p.x + Math.sin(t * 2 + p.n * 9) * p.size * 0.4, p.y, p.size, 330 + p.n * 30);
      continue;
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    if (kind === 'confetti') {
      ctx.rotate(p.r);
      ctx.scale(1, Math.abs(Math.cos(p.r * 1.7)) * 0.8 + 0.2); // a flat piece turning over
      ctx.fillStyle = `hsl(${Math.round(p.n * 360)} 85% 60%)`;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    } else {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size * 1.6);
      g.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, p.size * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Colour filters use canvas blend modes, which every engine has (Safari's
// canvas has no ctx.filter on older versions).
function filter(ctx: Ctx, id: EffectId, w: number, h: number) {
  const fill = (mode: GlobalCompositeOperation, style: string) => {
    ctx.globalCompositeOperation = mode;
    ctx.fillStyle = style;
    ctx.fillRect(0, 0, w, h);
  };
  if (id === 'bw' || id === 'sepia') fill('saturation', '#000');
  if (id === 'sepia') fill('color', 'rgba(112, 66, 20, 0.55)');
  if (id === 'warm') fill('overlay', 'rgba(255, 140, 40, 0.4)');
  if (id === 'cool') fill('overlay', 'rgba(60, 140, 255, 0.35)');
  ctx.globalCompositeOperation = 'source-over';
}

// A seeded random: a scene looks the same every time it is drawn.
function seeded(seed: number): Rand {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

// scene paints a made-up background (no photos to license or ship).
function scene(ctx: Ctx, id: Exclude<BgId, 'blur'>, w: number, h: number) {
  const rand = seeded(7);
  const linear = (stops: string[]) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  const glow = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  };
  const s = Math.min(w, h);
  if (id === 'sunset') {
    linear(['#2b1055', '#d53a9d', '#ff8c42', '#ffd166']);
    glow(w * 0.5, h * 0.68, s * 0.5, 'rgba(255, 230, 150, 0.9)');
    ctx.fillStyle = '#ffe9a8';
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.68, s * 0.13, 0, Math.PI * 2);
    ctx.fill();
    const sea = ctx.createLinearGradient(0, h * 0.72, 0, h);
    sea.addColorStop(0, '#5b3a8a');
    sea.addColorStop(1, '#1b1035');
    ctx.fillStyle = sea;
    ctx.fillRect(0, h * 0.72, w, h * 0.28);
  } else if (id === 'night') {
    linear(['#05081a', '#0e1a40', '#24386b']);
    for (let i = 0; i < 160; i++) {
      ctx.globalAlpha = 0.4 + rand() * 0.6;
      ctx.fillStyle = '#fff';
      ctx.fillRect(rand() * w, rand() * h * 0.8, 1 + rand() * 2, 1 + rand() * 2);
    }
    ctx.globalAlpha = 1;
    glow(w * 0.8, h * 0.2, s * 0.25, 'rgba(255, 255, 230, 0.35)');
    ctx.fillStyle = '#fffbe6';
    ctx.beginPath();
    ctx.arc(w * 0.8, h * 0.2, s * 0.07, 0, Math.PI * 2);
    ctx.fill();
  } else if (id === 'bokeh') {
    linear(['#0f2027', '#203a43', '#2c5364']);
    for (let i = 0; i < 30; i++)
      glow(rand() * w, rand() * h, s * (0.05 + rand() * 0.12), `hsla(${Math.round(rand() * 360)} 90% 70% / ${0.25 + rand() * 0.35})`);
  } else {
    const g = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.75);
    g.addColorStop(0, '#f2f2f2');
    g.addColorStop(1, '#8a8a8a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

// ---------- the pipeline ----------

export interface Effects {
  readonly camera: MediaStreamTrack; // the bare camera, still owned by the caller
  readonly track: MediaStreamTrack; // the picture with the effects, to send and to show
  readonly look: Look;
  // set changes the look; it resolves once the models it needs have loaded.
  set(look: Look): Promise<void>;
  stop(): void; // the canvas and its track; not the camera
}

// The picture keeps the camera's shape, at most this wide.
const MAX_SIDE = 1280;

const canvas2d = (w = 1, h = 1) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d')! };
};

// Where the canvas filter exists, a real blur; elsewhere (older Safari) a
// tiny copy scaled up does it.
const canBlur = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

// startEffects draws `camera` with the look on a canvas and returns the
// canvas's track. onGiveUp fires when the device cannot keep up ('slow')
// or the models keep failing ('failed'); the loop has stopped by then.
export async function startEffects(camera: MediaStreamTrack, first: Look, onGiveUp: (why: 'slow' | 'failed') => void): Promise<Effects> {
  const engines = await import('./face');
  type Landmarker = Awaited<ReturnType<typeof engines.landmarker>>;
  type Segmenter = Awaited<ReturnType<typeof engines.segmenter>>;
  let faces: Landmarker | null = null;
  let person: Segmenter | null = null;
  const needs = async (l: Look) => {
    if (l.effect && EFFECTS.find((e) => e.id === l.effect)?.face && !faces) faces = await engines.landmarker();
    if (l.bg && !person) person = await engines.segmenter();
  };
  await needs(first);
  // The first load takes seconds: the camera may be switched or off by now.
  if (camera.readyState === 'ended') throw new Error('camera ended');

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([camera]);
  // Kept in the page, not display:none: WebKit stops decoding a hidden
  // camera preview (WebKit bug 321693).
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  document.body.append(video);
  const { c: canvas, ctx } = canvas2d();
  const cut = canvas2d(); // the person, cut out by the mask
  const small = canvas2d(); // the mask, at the segmenter's size; and the cheap blur
  const back = canvas2d(); // the background scene, painted once per size
  const tiny = canvas2d(); // the cheap blur where the canvas has no filter
  let track: MediaStreamTrack | undefined;
  let running = true;
  let handle = 0;
  const rvfc = 'requestVideoFrameCallback' in video;
  const release = () => {
    running = false;
    if (rvfc) video.cancelVideoFrameCallback(handle);
    else cancelAnimationFrame(handle);
    track?.stop();
    video.srcObject = null;
    video.remove();
  };
  try {
    // A camera that ends now would leave play() pending for good.
    const playing = video.play();
    playing.catch(() => {});
    await Promise.race([playing, new Promise((_, no) => setTimeout(() => no(new Error('camera')), 5000))]);
  } catch (e) {
    release();
    throw e;
  }

  let look = { ...first };
  const tracker = new Tracker();
  let missed = 0;
  let errors = 0;
  let lastFace = 0;
  let lastMask = 0;
  let maskReady = false;
  let prevMask = new Float32Array(0);
  let maskData: ImageData | null = null;
  let scenePainted = '';
  let last = performance.now();
  let slow = 0;
  let kind: ParticleKind | null = null;
  let ps: Particle[] = [];
  const puffs: Puff[] = [];
  let w = 0;
  let h = 0;

  // fit: the canvas follows the picture's shape (a phone turned mid-call;
  // iOS reports the camera's size before rotation). Its track carries on.
  const fit = () => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;
    const k = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    if (Math.round(vw * k) !== w || Math.round(vh * k) !== h) {
      canvas.width = cut.c.width = back.c.width = w = Math.round(vw * k);
      canvas.height = cut.c.height = back.c.height = h = Math.round(vh * k);
      tiny.c.width = Math.max(8, Math.round(w / 24));
      tiny.c.height = Math.max(8, Math.round(h / 24));
      tracker.clear();
      scenePainted = '';
      kind = null; // particles start over on the new picture
    }
    return true;
  };
  fit();
  track = canvas.captureStream(30).getVideoTracks()[0];

  const giveUp = (why: 'slow' | 'failed') => {
    running = false;
    onGiveUp(why);
  };

  // segment updates the background mask from the current frame.
  const segment = (now: number) => {
    const res = person!.segmentForVideo(video, now);
    try {
      const masks = res.confidenceMasks;
      const m = masks?.[masks.length - 1]; // the person: the last category where there are several
      if (!m) return;
      if (small.c.width !== m.width || small.c.height !== m.height || !maskData) {
        small.c.width = m.width;
        small.c.height = m.height;
        maskData = small.ctx.createImageData(m.width, m.height);
        prevMask = new Float32Array(m.width * m.height);
      }
      maskAlpha(m.getAsFloat32Array(), prevMask, maskData.data);
      small.ctx.putImageData(maskData, 0, 0);
      maskReady = true;
    } finally {
      res.close();
    }
  };

  // background draws everything behind the person.
  const background = (bg: BgId) => {
    if (bg === 'blur') {
      if (canBlur) {
        ctx.filter = `blur(${Math.round(Math.min(w, h) / 40)}px)`;
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = 'none';
      } else {
        tiny.ctx.drawImage(video, 0, 0, tiny.c.width, tiny.c.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tiny.c, 0, 0, w, h);
      }
      return;
    }
    if (scenePainted !== `${bg}:${w}x${h}`) {
      scene(back.ctx, bg, w, h);
      scenePainted = `${bg}:${w}x${h}`;
    }
    ctx.drawImage(back.c, 0, 0);
  };

  const frame = () => {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (video.readyState >= 2 && fit()) {
      const id = look.effect;
      const face = !!id && !!EFFECTS.find((e) => e.id === id)?.face && !!faces;
      const bg = person ? look.bg : null;
      // One model run a frame at most, each about 15 times a second; the
      // drawing glides in between.
      try {
        if (face && now - lastFace > 66 && (!bg || lastMask >= lastFace)) {
          lastFace = now;
          const res = faces!.detectForVideo(video, now);
          const heads = res.faceLandmarks.flatMap((lm, i) => {
            const hd = headFrom(lm, w, h);
            if (hd) Object.assign(hd, expression(res.faceBlendshapes?.[i]?.categories ?? []));
            return hd ? [hd] : [];
          });
          if (heads.length) {
            tracker.update(heads, now / 1000);
            missed = 0;
          } else if (++missed > 5) tracker.clear(); // gone, not just one missed frame
          errors = 0;
        } else if (bg && now - lastMask > 66) {
          lastMask = now;
          segment(now);
          errors = 0;
        }
      } catch {
        if (++errors > 10) return giveUp('failed'); // one bad frame is "no face"
      }
      // With a background chosen the room never shows: until the first mask
      // only the background is drawn.
      if (look.bg) {
        if (bg) background(bg);
        else background('blur');
      }
      if (bg && maskReady) {
        cut.ctx.globalCompositeOperation = 'copy';
        cut.ctx.drawImage(video, 0, 0, w, h);
        cut.ctx.globalCompositeOperation = 'destination-in';
        cut.ctx.imageSmoothingQuality = 'high';
        cut.ctx.drawImage(small.c, 0, 0, w, h);
        cut.ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(cut.c, 0, 0);
      } else if (!look.bg) ctx.drawImage(video, 0, 0, w, h);
      if (id) filter(ctx, id, w, h);
      if (face)
        for (const hd of tracker.heads(dt)) {
          overlay(ctx, id!, hd, now / 1000);
          // A kiss blows hearts, an open mouth breathes fire.
          if (id === 'kiss' && hd.pucker > 0.35 && Math.random() < dt * 8) puffs.push(puff(hd.mouth, 'heart', hd.size * 0.35));
          if (id === 'fire' && hd.open > 0.3) for (let i = 0; i < 3; i++) puffs.push(puff(hd.mouth, 'flame', hd.size * (0.15 + hd.open * 0.3)));
        }
      stepPuffs(puffs, dt);
      drawPuffs(ctx, puffs);
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
      if (slow > 30) return giveUp('slow');
    }
    handle = rvfc ? video.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
  };
  frame();

  return {
    camera,
    track,
    get look() {
      return look;
    },
    async set(next: Look) {
      await needs(next);
      if (next.effect !== look.effect) {
        tracker.clear();
        puffs.length = 0;
      }
      if (!look.bg) maskReady = false; // the mask does not depend on which background
      look = { ...next };
    },
    stop: release,
  };
}

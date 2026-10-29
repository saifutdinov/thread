import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expression, headFrom, maskAlpha, OneEuro, particles, puff, stepParticles, stepPuffs } from './effects.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// A face mesh with only the points the effects read set; the rest sit in
// the middle. Indices as in MediaPipe's FaceLandmarker (478 points).
function mesh(p: Record<number, [number, number]>) {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const [i, [x, y]] of Object.entries(p)) pts[Number(i)] = { x, y, z: 0 };
  return pts;
}
// A level face: eyes (iris centres 468, 473), forehead top 10, chin 152,
// nose tip 1, mouth corners 61/291, face sides 234/454.
const level = mesh({
  468: [0.4, 0.4],
  473: [0.6, 0.4],
  10: [0.5, 0.2],
  152: [0.5, 0.8],
  1: [0.5, 0.5],
  61: [0.44, 0.65],
  291: [0.56, 0.65],
  234: [0.3, 0.45],
  454: [0.7, 0.45],
});

test('headFrom places the head between the eyes, level and sized by them', () => {
  const h = headFrom(level, 1000, 500)!;
  near(h.mid.x, 500);
  near(h.mid.y, 200);
  near(h.roll, 0);
  near(h.size, 200); // eyes 0.2 of 1000 px apart
  near(h.width, 400); // face sides 0.4 apart
  near(h.top.y, 100);
  near(h.chin.y, 400);
  near(h.mouthL.x, 440);
});

test('headFrom follows a tilted head', () => {
  const a = Math.PI / 6;
  const h = headFrom(mesh({ 468: [0.5, 0.5], 473: [0.5 + 0.1 * Math.cos(a), 0.5 + 0.1 * Math.sin(a)] }), 1000, 1000)!;
  near(h.roll, a);
  near(h.size, 100);
});

test('a mirrored picture still gives an upright head, left on the left', () => {
  const flipped = mesh({ 468: [0.6, 0.4], 473: [0.4, 0.4], 61: [0.56, 0.65], 291: [0.44, 0.65], 234: [0.7, 0.45], 454: [0.3, 0.45] });
  const h = headFrom(flipped, 1000, 1000)!;
  near(h.roll, 0);
  assert.ok(h.eyeL.x < h.eyeR.x && h.mouthL.x < h.mouthR.x && h.sideL.x < h.sideR.x);
});

test('headFrom needs a whole face mesh', () => {
  assert.equal(headFrom([{ x: 0.4, y: 0.4, z: 0 }], 100, 100), null);
});

test('expression reads an open mouth and a kiss from the blendshapes', () => {
  const cats = [
    { categoryName: 'jawOpen', score: 0.7 },
    { categoryName: 'mouthPucker', score: 0.2 },
    { categoryName: 'eyeBlinkLeft', score: 0.9 },
  ];
  assert.deepEqual(expression(cats), { open: 0.7, pucker: 0.2 });
  assert.deepEqual(expression([]), { open: 0, pucker: 0 }); // no blendshapes: a calm face
});

test('the One Euro filter keeps a still face still and follows a moving one', () => {
  const f = new OneEuro();
  // Jitter of ±2 px around 100: the output varies far less than the input.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 60; i++) {
    const y = f.filter(100 + (i % 2 ? 2 : -2), i / 30);
    if (i > 10) {
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  assert.ok(hi - lo < 1.5, `jitter ${hi - lo} px`);
  // A quick move to 300: caught up within a quarter of a second.
  let y = 0;
  for (let i = 60; i < 68; i++) y = f.filter(300, i / 30);
  assert.ok(y > 290, `lagging at ${y}`);
});

test('maskAlpha turns person confidence into a steady, softened alpha', () => {
  const out = new Uint8ClampedArray(4 * 3);
  const prev = new Float32Array(3);
  maskAlpha(new Float32Array([0, 0.5, 1]), prev, out);
  // Half way from the previous frame (all background) to the new reading.
  assert.deepEqual([out[3], out[7], out[11]], [0, Math.round(255 * 0.25), Math.round(255 * 0.5)]);
  maskAlpha(new Float32Array([0, 0.5, 1]), prev, out);
  assert.ok(out[11] > Math.round(255 * 0.5), 'keeps moving towards the reading');
});

test('puffs fly out and fade away', () => {
  const ps = [puff({ x: 100, y: 100 }, 'heart', 20, () => 0.5)];
  stepPuffs(ps, 0.2);
  assert.equal(ps.length, 1);
  assert.ok(ps[0].x !== 100 || ps[0].y !== 100, 'it moved');
  stepPuffs(ps, 5);
  assert.equal(ps.length, 0, 'gone after its life');
});

// A fixed sequence instead of Math.random: tests stay deterministic.
const seq = (...v: number[]) => {
  let i = 0;
  return () => v[i++ % v.length];
};

test('snow and confetti fall, hearts rise', () => {
  for (const [kind, down] of [
    ['snow', true],
    ['confetti', true],
    ['hearts', false],
  ] as const) {
    const ps = particles(kind, 5, 400, 300, seq(0.5));
    const before = ps.map((p) => p.y);
    stepParticles(ps, kind, 0.1, 400, 300, seq(0.5));
    ps.forEach((p, i) => assert.ok(down ? p.y > before[i] : p.y < before[i], `${kind} moved the wrong way`));
  }
});

test('particles that leave the picture come back from the other edge', () => {
  const ps = particles('snow', 3, 400, 300, seq(0.5));
  ps.forEach((p) => (p.y = 400)); // all below the bottom
  stepParticles(ps, 'snow', 0.01, 400, 300, seq(0.25));
  assert.equal(ps.length, 3);
  ps.forEach((p) => assert.ok(p.y < 0, 'snow restarts above the top'));

  const hs = particles('hearts', 3, 400, 300, seq(0.5));
  hs.forEach((p) => (p.y = -100)); // all above the top
  stepParticles(hs, 'hearts', 0.01, 400, 300, seq(0.25));
  hs.forEach((p) => assert.ok(p.y > 300, 'hearts restart below the bottom'));
});

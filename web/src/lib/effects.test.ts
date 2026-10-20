import assert from 'node:assert/strict';
import { test } from 'node:test';
import { follow, headFrom, particles, stepParticles } from './effects.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// The detector's keypoints: left eye, right eye (as seen), nose, mouth, ears.
const face = (lx: number, ly: number, rx: number, ry: number) => [
  { x: lx, y: ly },
  { x: rx, y: ry },
  { x: 0.5, y: 0.5 },
  { x: 0.5, y: 0.6 },
  { x: 0.3, y: 0.45 },
  { x: 0.7, y: 0.45 },
];

test('headFrom places the head between the eyes, level and sized by them', () => {
  const h = headFrom(face(0.4, 0.4, 0.6, 0.4), 1000, 500)!;
  near(h.x, 500);
  near(h.y, 200);
  near(h.roll, 0);
  near(h.size, 200); // eyes 0.2 of 1000 px apart
});

test('headFrom follows a tilted head', () => {
  // Right eye lower than the left one: the head leans to the right side.
  const a = Math.PI / 6;
  const h = headFrom(face(0.5, 0.5, 0.5 + 0.1 * Math.cos(a), 0.5 + 0.1 * Math.sin(a)), 1000, 1000)!;
  near(h.roll, a);
  near(h.size, 100);
});

test('headFrom needs both eyes', () => {
  assert.equal(headFrom([{ x: 0.4, y: 0.4 }], 100, 100), null);
});

test('follow moves part of the way, so the overlay does not jitter', () => {
  const a = { x: 0, y: 0, roll: 0, size: 100 };
  const b = { x: 100, y: 50, roll: 0.2, size: 200 };
  const m = follow(a, b, 0.5);
  near(m.x, 50);
  near(m.y, 25);
  near(m.roll, 0.1);
  near(m.size, 150);
  assert.deepEqual(follow(null, b, 0.5), b); // the first sighting is taken as is
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

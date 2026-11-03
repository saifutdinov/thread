// Small pieces of the call screen's touch handling, kept pure for tests.

export interface Tap {
  t: number; // ms
  x: number;
  y: number;
}

// isDoubleTap: this tap follows the previous one quickly and close by.
// Built from pointer events, so it works the same for a mouse, a finger
// and a pen (mobile browsers do not all send dblclick).
export function isDoubleTap(prev: Tap | null, now: Tap, ms = 350, px = 30): boolean {
  return !!prev && now.t - prev.t <= ms && Math.abs(now.x - prev.x) <= px && Math.abs(now.y - prev.y) <= px;
}

// tileWidth: a small picture takes its own shape; a landscape one gets
// more width so it is not a sliver. The height cap goes into the width
// too (40% of the screen): a height cap of its own would break the shape.
export function tileWidth(w: number, h: number): string {
  const base = w > h ? '12rem, 40vw' : '8rem, 28vw';
  return w && h ? `min(${base}, calc(40vh * ${w} / ${h}))` : `min(${base})`;
}

type Size = { w: number; h: number };

// placeTile turns where a dragged tile's top left corner is wanted, in px
// within the room it moves in (.call-room), into fractions of the room it
// has left, kept within it.
export function placeTile(room: Size, tile: Size, left: number, top: number): [number, number] {
  const frac = (at: number, size: number, own: number) => (size > own ? Math.min(1, Math.max(0, at / (size - own))) : 0);
  return [frac(left, room.w, tile.w), frac(top, room.h, tile.h)];
}

// jumbo counts the emoji in a message made of 1-3 emoji and nothing else,
// so it can be drawn large without a bubble; 0 otherwise. Graphemes, so
// flags, skin tones and ZWJ families count as one.
const ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u;
const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const graphemes = new Intl.Segmenter();

export function jumbo(text: string): number {
  const s = text.replace(/\s+/g, '');
  if (!s || s.length > 40 || !ONLY.test(s)) return 0;
  const parts = [...graphemes.segment(s)];
  return parts.length <= 3 && parts.every((p) => PICTURE.test(p.segment)) ? parts.length : 0;
}

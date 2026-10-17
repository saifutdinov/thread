import type { ComponentChild } from 'preact';

// Telegram-style markers: **bold**, __italic__, ~~strike~~, `code`, and
// lines starting with "> " form a quote. Links are detected, http(s) only.
const INLINE =
  /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|`([^`\n]+?)`|(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'»])/g;

function inline(text: string, key: string): ComponentChild[] {
  const out: ComponentChild[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = key + '.' + i++;
    if (m[1] !== undefined) out.push(<b key={k}>{inline(m[1], k)}</b>);
    else if (m[2] !== undefined) out.push(<i key={k}>{inline(m[2], k)}</i>);
    else if (m[3] !== undefined) out.push(<s key={k}>{inline(m[3], k)}</s>);
    else if (m[4] !== undefined) out.push(<code key={k}>{m[4]}</code>);
    else
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noopener noreferrer">
          {m[5]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// firstLink is the first link the text would render, for a link preview.
export function firstLink(text: string): string | undefined {
  for (const m of text.matchAll(INLINE)) if (m[5]) return m[5];
}

export function Markup({ text }: { text: string }) {
  const blocks: ComponentChild[] = [];
  let buf: string[] = [];
  let quote = false;
  const flush = () => {
    if (!buf.length) return;
    const k = String(blocks.length);
    const body = inline(buf.join('\n'), k);
    blocks.push(quote ? <blockquote key={k}>{body}</blockquote> : <span key={k}>{body}</span>);
    buf = [];
  };
  for (const line of text.split('\n')) {
    const q = /^>\s?/.test(line);
    if (q !== quote) {
      flush();
      quote = q;
    }
    buf.push(q ? line.replace(/^>\s?/, '') : line);
  }
  flush();
  return <>{blocks}</>;
}

// plain strips the markers for previews and notifications.
export const plain = (text: string) =>
  text
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

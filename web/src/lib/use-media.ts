import { useEffect, useRef, useState } from 'preact/hooks';
import type { MediaLease } from './media-cache';
import { type Attachment, acquireMedia } from './store';

// Load nearby tiles, then retain their source until unmount so scrolling
// preserves paused playback positions and does not flash image thumbnails.
export function useDecrypted(a: Attachment, automatic = true) {
  const ref = useRef<HTMLElement>(null);
  const [url, setUrl] = useState<string>();
  const held = useRef<MediaLease | null>(null);
  const load = () => {
    if (held.current) return held.current.url;
    const lease = acquireMedia(a);
    held.current = lease;
    lease.url.then(
      (u) => {
        if (held.current === lease) setUrl(u);
      },
      () => {
        if (held.current === lease) {
          lease.release();
          held.current = null;
        }
      },
    );
    return lease.url;
  };
  useEffect(() => {
    setUrl(undefined);
    const el = ref.current;
    const io =
      el && automatic
        ? new IntersectionObserver(
            (es) => {
              if (es.some((e) => e.isIntersecting)) void load().catch(() => {});
            },
            { root: el.closest('.messages'), rootMargin: '600px' },
          )
        : null;
    if (io && el) io.observe(el);
    return () => {
      io?.disconnect();
      held.current?.release();
      held.current = null;
    };
  }, [a.id]);
  return {
    ref: (el: HTMLElement | null) => {
      ref.current = el;
    },
    url,
    load,
  };
}

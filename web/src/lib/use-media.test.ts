import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { MediaCache } from './media-cache.ts';

test('scrolling retains mounted media and playback position even under cache pressure', async () => {
  const source = readFileSync(new URL('./use-media.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')).replace(/\bexport\s+/g, '');
  let effect!: () => () => void, visibility!: (entries: { isIntersecting: boolean }[]) => void;
  let currentURL: string | undefined,
    reads = 0,
    next = 0;
  const revoked: string[] = [];
  const root = {};
  let observerRoot: unknown;
  const cache = new MediaCache(4, 1, {
    create: () => `blob:${++next}`,
    revoke: (u) => revoked.push(u),
  });
  const context = vm.createContext({
    useRef: (current: unknown) => ({ current }),
    useState: () => [
      undefined,
      (url: string | undefined) => {
        currentURL = url;
      },
    ],
    useEffect: (f: typeof effect) => {
      effect = f;
    },
    acquireMedia: () =>
      cache.acquire('voice', async () => {
        reads++;
        return new Blob(['1234']);
      }),
    IntersectionObserver: class {
      constructor(callback: typeof visibility, options: { root?: unknown }) {
        visibility = callback;
        observerRoot = options.root;
      }
      observe() {}
      disconnect() {}
    },
  });
  vm.runInContext(code + '\nglobalThis.subject=useDecrypted({id:"voice"});', context);
  const s = (
    context as unknown as {
      subject: { ref: (el: unknown) => void; load: () => Promise<string> };
    }
  ).subject;
  const listeners = new Map<string, () => void>();
  s.ref({
    closest: () => root,
    querySelectorAll: () => [{ paused: true, currentTime: 12 }],
    addEventListener: (name: string, f: () => void) => listeners.set(name, f),
    removeEventListener() {},
  });
  const unmount = effect();
  visibility([{ isIntersecting: true }]);
  const url = await s.load();
  visibility([{ isIntersecting: false }]);
  const other = cache.acquire('other', async () => new Blob(['5678']));
  await other.url;
  other.release();
  listeners.get('pause')?.();
  assert.equal(currentURL, url, 'paused players must keep their DOM source and position');
  assert.equal(observerRoot, root, 'preload margin must use the message scroll container');
  assert.ok(!revoked.includes(url));
  visibility([{ isIntersecting: true }]);
  assert.equal(await s.load(), url);
  assert.equal(reads, 1);
  unmount();
  const pressure = cache.acquire('pressure', async () => new Blob(['more']));
  await pressure.url;
  assert.ok(revoked.includes(url), 'unmounted media must become evictable');
  pressure.release();
  cache.clear();
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function port(url = 'https://chat.example.org/') {
  const messages: Record<string, unknown>[] = [],
    incoming: ((m: unknown) => void)[] = [],
    closed: (() => void)[] = [];
  let disconnected = false;
  return {
    name: 'thread-ptt',
    sender: { url, frameId: 0 },
    messages,
    incoming,
    closed,
    onMessage: { addListener: (f: (m: unknown) => void) => incoming.push(f) },
    onDisconnect: { addListener: (f: () => void) => closed.push(f) },
    postMessage: (m: Record<string, unknown>) => {
      if (disconnected) throw new Error('disconnected port');
      messages.push(m);
    },
    disconnect: () => {
      disconnected = true;
      closed.forEach((f) => f());
    },
    isClosed: () => disconnected,
  };
}
function background() {
  let connect!: (p: ReturnType<typeof port>) => void;
  const hosts: ReturnType<typeof port>[] = [];
  let clock = 10000;
  const context = vm.createContext({
    URL,
    Date: { now: () => clock },
    importScripts() {},
    THREAD_PTT_ORIGINS: ['https://chat.example.org'],
    chrome: {
      runtime: {
        onConnect: {
          addListener: (f: typeof connect) => {
            connect = f;
          },
        },
        connectNative: () => {
          const p = port();
          hosts.push(p);
          return p;
        },
      },
    },
  });
  vm.runInContext(readFileSync(new URL('../../../desktop/extension/background.js', import.meta.url), 'utf8'), context);
  return {
    connect,
    hosts,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
const config = {
  type: 'configure',
  enabled: true,
  connect: true,
  session: 'one',
  binding: { code: 'F9', ctrl: false, shift: true, alt: false, meta: false },
};
test('native bridge rejects foreign pages and lets only one tab own global input', () => {
  const b = background();
  const foreign = port('https://example.org/');
  b.connect(foreign);
  assert.equal(foreign.isClosed(), true);
  assert.equal(b.hosts.length, 0);
  const first = port(),
    second = port();
  b.connect(first);
  b.connect(second);
  first.incoming[0](config);
  second.incoming[0]({ ...config, session: 'two' });
  assert.equal(second.messages.at(-1)?.status, 'busy');
  assert.equal(b.hosts[0].messages.length, 1);
  b.hosts[0].incoming[0]({ type: 'ready', version: 1 });
  b.hosts[0].incoming[0]({ type: 'state', down: true, session: 'one' });
  assert.equal(first.messages.at(-1)?.down, true);
  first.disconnect();
  assert.equal(b.hosts[0].isClosed(), true);
});
test('unexpected native protocol and disconnect fail closed', () => {
  const b = background(),
    p = port();
  b.connect(p);
  p.incoming[0](config);
  b.hosts[0].incoming[0]({ type: 'state', down: true, session: 'one' });
  assert.equal(
    p.messages.some((m) => m.down === true),
    false,
  );
  b.hosts[0].incoming[0]({ type: 'ready', version: 2 });
  assert.equal(p.messages.at(-1)?.down, false);
  assert.equal(p.messages.at(-1)?.status, 'error');
});

test('content bridge reconnects after its worker port closes and ignores late old-port events', () => {
  let receive!: (e: unknown) => void;
  const posts: Record<string, unknown>[] = [],
    ports: ReturnType<typeof port>[] = [];
  const window = {
    addEventListener: (_: string, fn: typeof receive) => {
      receive = fn;
    },
    postMessage: (m: Record<string, unknown>) => posts.push(m),
  };
  const context = vm.createContext({
    THREAD_PTT_ORIGINS: ['https://chat.example.org'],
    location: { origin: 'https://chat.example.org' },
    window,
    chrome: {
      runtime: {
        connect: () => {
          const p = port();
          ports.push(p);
          return p;
        },
      },
    },
  });
  vm.runInContext(readFileSync(new URL('../../../desktop/extension/content.js', import.meta.url), 'utf8'), context);
  const send = (data: object) =>
    receive({ source: window, origin: 'https://chat.example.org', data: { source: 'thread-ptt', ...data } });
  send(config);
  ports[0].disconnect();
  assert.equal(posts.at(-1)?.status, 'error');
  assert.doesNotThrow(() => send({ ...config, session: 'retry' }));
  assert.equal(ports.length, 2);
  assert.equal(ports[1].messages.at(-1)?.session, 'retry');
  const count = posts.length;
  ports[0].closed.forEach((fn) => fn());
  assert.equal(posts.length, count, 'old-port disconnect must not mute a fresh connection');
  ports[1].postMessage = () => {
    throw new Error('worker stopped');
  };
  assert.doesNotThrow(() => send({ ...config, session: 'failed' }));
  assert.equal(posts.at(-1)?.status, 'error');
  send({ ...config, session: 'recovered' });
  assert.equal(ports[2].messages.at(-1)?.session, 'recovered');
  send({ ...config, connect: false, enabled: false });
  assert.equal(ports[2].isClosed(), true);
});

test('production extension refuses localhost and only its generated dev build includes local origins', () => {
  const b = background();
  for (const url of ['http://localhost:8080/', 'http://localhost:5173/', 'http://localhost:8086/']) {
    const p = port(url);
    b.connect(p);
    assert.equal(p.isClosed(), true);
  }
  const manifest = JSON.parse(readFileSync(new URL('../../../desktop/extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://chat.example.org/*']);
  const origins = readFileSync(new URL('../../../desktop/extension/origins.js', import.meta.url), 'utf8');
  assert.equal(origins.includes('localhost'), false);
  assert.equal(b.hosts.length, 0);
});

test('a disconnected configure does not reserve ownership and rapid binding changes cannot restart around the limit', () => {
  const b = background(),
    one = port(),
    two = port();
  b.connect(one);
  b.connect(two);
  one.incoming[0]({ ...config, connect: false });
  two.incoming[0](config);
  assert.equal(b.hosts.length, 1, 'the second tab can still connect');
  two.disconnect();
  const next = port();
  b.connect(next);
  next.incoming[0]({ ...config, binding: { ...config.binding, code: 'KeyA' } });
  assert.equal(b.hosts.length, 1, 'host restarts must not bypass the extension rate limit');
  assert.equal(next.messages.at(-1)?.status, 'error');
  b.advance(1000);
  next.incoming[0]({ ...config, binding: { ...config.binding, code: 'KeyA' } });
  assert.equal(b.hosts.length, 2);
});

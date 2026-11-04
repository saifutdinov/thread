import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCipheriv, randomBytes, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';

function worker(options: { cold?: boolean; lingering?: boolean } = {}) {
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const notes: { tag: string; data: Record<string, unknown>; close: () => void }[] = [];
  const handlers = new Map<string, (e: unknown) => void>();
  const written: Record<string, unknown> = {};
  const delivered: unknown[] = [];
  const stored = new Map<string, unknown>([['lang', 'en']]);
  const requests: string[] = [],
    windows: string[] = [];
  const client = {
    postMessage: (m: unknown) => delivered.push(m),
    focus: async () => {
      windows.push('focus');
      return client;
    },
  };
  let opened = !options.cold;
  let statusWait: Promise<void> | undefined;
  let ringing: boolean | null = true;
  const context = vm.createContext({
    self: {
      addEventListener: (name: string, handler: (e: unknown) => void) => handlers.set(name, handler),
      registration: {
        getNotifications: async (filter?: { tag: string }) => notes.filter((n) => !filter || n.tag === filter.tag),
        showNotification: async (title: string, options: Record<string, unknown>) => {
          shown.push({ title, options });
          const old = notes.find((n) => n.tag === options.tag);
          if (old) notes.splice(notes.indexOf(old), 1);
          const note = {
            ...options,
            title,
            tag: options.tag as string,
            data: options.data as Record<string, unknown>,
            close: () => {
              const index = notes.indexOf(note);
              if (index >= 0 && !options.lingering) notes.splice(index, 1);
            },
          };
          notes.push(note);
        },
      },
      clients: {
        matchAll: async () => (opened ? [client] : []),
        openWindow: async () => {
          windows.push('open');
          opened = true;
          return client;
        },
      },
      navigator: {},
    },
    navigator: {},
    AbortSignal,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
    atob,
    crypto: webcrypto,
    Uint8Array,
    Date,
    fetch: async (url: string) => {
      requests.push(url);
      if (url === '/api/calls/decline') return { ok: true };
      await statusWait;
      if (ringing === null) throw new Error('offline');
      return { ok: true, json: async () => ({ ringing }) };
    },
    testGet: async (key: string) => stored.get(key),
    testSet: async (key: string, value: unknown) => {
      written[key] = value;
    },
  });
  vm.runInContext(
    readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8') + '\nidbGet=testGet;idbSet=testSet;globalThis.subject={onPush};',
    context,
  );
  const subject = (context as unknown as { subject: { onPush: (data: unknown) => Promise<void> } }).subject;
  return {
    ...subject,
    shown,
    notes,
    written,
    delivered,
    handlers,
    stored,
    requests,
    windows,
    waitStatus: (wait: Promise<void>) => {
      statusWait = wait;
    },
    setStatus: (value: boolean | null) => {
      ringing = value;
    },
  };
}

test('only a confirmed inactive call suppresses interactive ringing', async () => {
  const w = worker();
  for (const status of [false]) {
    w.setStatus(status);
    await w.onPush({ t: 'call', c: 1, id: 'old', n: 'Alice' });
    const { options } = w.shown.at(-1)!;
    assert.equal(options.tag, 'call-ended');
    assert.equal(options.silent, true);
    assert.equal(options.requireInteraction, undefined);
    assert.equal(options.actions, undefined);
  }
});

test('unavailable status still rings and preserves answer and join actions', async () => {
  for (const group of [false, true]) {
    const w = worker();
    w.setStatus(null);
    await w.onPush({ t: 'call', c: 1, id: 'live', g: group });
    const { options } = w.shown.at(-1)!;
    assert.equal(options.tag, group ? 'gcall' : 'call');
    assert.notEqual(options.silent, true);
    assert.ok((options.actions as unknown[]).length > 0);
    let work!: Promise<void>;
    w.handlers.get('notificationclick')!({
      action: group ? 'join' : 'answer',
      notification: { data: { call: !group, gcall: group, c: 1, id: 'live', url: '/#/c/1' }, close() {} },
      waitUntil: (p: Promise<void>) => {
        work = p;
      },
    });
    await work;
    assert.equal((w.written[group ? 'gjoin' : 'answer'] as { id: string }).id, 'live');
  }
});

test('decline reaches the server without waiting for a status check or opening a window', async () => {
  const w = worker({ cold: true });
  w.setStatus(null);
  w.waitStatus(new Promise(() => {}));
  let work!: Promise<void>;
  w.handlers.get('notificationclick')!({
    action: 'decline',
    notification: { data: { call: true, c: 1, id: 'live' }, close() {} },
    waitUntil: (p: Promise<void>) => {
      work = p;
    },
  });
  await work;
  assert.deepEqual(w.requests, ['/api/calls/decline']);
  assert.deepEqual(w.windows, []);
});

test('answer and join open or focus the app before waiting for the network, including newly opened clients', async () => {
  for (const cold of [false, true])
    for (const group of [false, true]) {
      const w = worker({ cold });
      let release!: () => void;
      w.waitStatus(
        new Promise<void>((r) => {
          release = r;
        }),
      );
      let work!: Promise<void>;
      w.handlers.get('notificationclick')!({
        action: group ? 'join' : 'answer',
        notification: { data: { call: !group, gcall: group, c: 1, id: 'live', url: '/#/c/1' }, close() {} },
        waitUntil: (p: Promise<void>) => {
          work = p;
        },
      });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(w.windows, [cold ? 'open' : 'focus']);
      assert.equal(w.delivered.length, 0);
      release();
      await work;
      assert.equal((w.delivered[0] as { t: string }).t, group ? 'gjoin' : 'call');
    }
});

test('a recently closed inactive notification cannot be resurrected with its actions', async () => {
  const w = worker({ lingering: true });
  await w.onPush({ t: 'call', c: 1, id: 'old' });
  w.setStatus(false);
  await w.onPush({ t: 'call', c: 1, id: 'old' });
  assert.equal(w.shown.at(-1)?.options.tag, 'call-ended');
  assert.equal(w.shown.at(-1)?.options.actions, undefined);
});

test('live calls remain actionable and group notifications carry the exact room id', async () => {
  const w = worker();
  await w.onPush({ t: 'call', c: 1, id: 'current', n: 'Alice' });
  assert.equal(w.shown[0].options.tag, 'call');
  assert.equal(w.shown[0].options.requireInteraction, true);
  await w.onPush({ t: 'call', c: 2, id: 'group-current', g: true });
  assert.equal((w.shown[1].options.data as { id: string }).id, 'group-current');
});

test('old end notifications cannot close a newer ringing call', async () => {
  const w = worker();
  let closed = false;
  w.notes.push({
    tag: 'call',
    data: { id: 'new' },
    close: () => {
      closed = true;
    },
  });
  await w.onPush({ t: 'callEnd', id: 'old' });
  await w.onPush({ t: 'callEnd' });
  assert.equal(closed, false);
  await w.onPush({ t: 'callEnd', id: 'new' });
  assert.equal(closed, true);
});

test('late encrypted call logs preserve active, unverified and other-chat rings', async () => {
  for (const [chat, status] of [
    [1, true],
    [1, null],
    [2, false],
    [1, false],
  ] as const) {
    const w = worker();
    await w.onPush({ t: 'call', c: 1, id: 'current' });
    const ended = {
      tag: 'call-ended',
      data: {},
      close: () => {
        w.notes.splice(w.notes.indexOf(ended), 1);
      },
    };
    w.notes.push(ended);
    w.setStatus(status);
    const raw = randomBytes(32),
      iv = randomBytes(12);
    w.stored.set(`k:${chat}:1`, raw);
    const cipher = createCipheriv('aes-256-gcm', raw, iv);
    cipher.setAAD(Buffer.from(`m:${chat}:1`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ cl: { s: 'missed', d: 0, v: false } })),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    await w.onPush({ c: chat, e: 1, m: 1, b: Buffer.concat([iv, ciphertext]).toString('base64') });
    assert.equal(
      w.notes.some((n) => n.tag === 'call'),
      chat !== 1 || status !== false,
      `chat=${chat}, status=${status}`,
    );
    assert.equal(w.shown.at(-1)?.options.tag, `c${chat}`, 'the encrypted call log is still displayed');
    assert.equal(
      w.notes.some((n) => n.tag === 'call-ended'),
      false,
      'the summary removes the temporary ended note',
    );
  }
});

test('answering a stale notification cannot answer a different current call', async () => {
  const w = worker();
  w.setStatus(false);
  let work!: Promise<void>;
  w.handlers.get('notificationclick')!({
    action: 'answer',
    notification: { data: { call: true, c: 1, id: 'old', url: '/#/c/1' }, close() {} },
    waitUntil: (p: Promise<void>) => {
      work = p;
    },
  });
  await work;
  assert.equal(w.written.answer, undefined);
  assert.equal(
    w.delivered.some((e) => (e as { t: string }).t === 'call'),
    false,
  );
});

test('live notification actions identify their call to every open tab', async () => {
  const w = worker();
  let work!: Promise<void>;
  w.handlers.get('notificationclick')!({
    action: 'answer',
    notification: { data: { call: true, c: 1, id: 'new', url: '/#/c/1' }, close() {} },
    waitUntil: (p: Promise<void>) => {
      work = p;
    },
  });
  await work;
  assert.deepEqual(JSON.parse(JSON.stringify(w.delivered[0])), { t: 'call', k: 'answer', id: 'new', c: 1 });
});

test('simultaneous push and end are processed in order, leaving no ringing notification', async () => {
  const w = worker();
  const tasks: Promise<void>[] = [];
  for (const data of [
    { t: 'call', c: 1, id: 'ending' },
    { t: 'callEnd', id: 'ending' },
  ]) {
    w.handlers.get('push')!({ data: { json: () => data }, waitUntil: (p: Promise<void>) => tasks.push(p) });
  }
  await Promise.all(tasks);
  assert.equal(
    w.notes.some((n) => n.tag === 'call'),
    false,
  );
});

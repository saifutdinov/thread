import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { mergeMessages } from './messages.ts';

const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source.slice(source.indexOf('function putMessages('), source.indexOf('\nconst isVisible'))).replace(
  /\bexport\s+/g,
  '',
);

for (const kind of ['open', 'older'])
  test(`late ${kind} history decryption cannot restore a cleared message`, async () => {
    let finish!: (messages: unknown[]) => void;
    const decryption = new Promise((resolve) => (finish = resolve));
    const chat = { cleared_upto: 0 };
    const old = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, cid: String(i + 1), seq: i + 1 }));
    const messages = { value: new Map([[1, kind === 'older' ? [{ id: 55, cid: 'later', seq: 55 }] : []]]) };
    const hasOlder = { value: new Map([[1, true]]) };
    const context = vm.createContext({
      messages,
      loaded: new Set(kind === 'older' ? [1] : []),
      hasOlder,
      findChat: () => chat,
      merge: mergeMessages,
      api: { messages: async () => old },
      hydrate: () => decryption,
    });
    vm.runInContext(code + '\nglobalThis.subject={openChat,loadOlder};', context);
    const s = (context as unknown as { subject: { openChat: (id: number) => Promise<void>; loadOlder: (id: number) => Promise<void> } })
      .subject;
    const loading = kind === 'open' ? s.openChat(1) : s.loadOlder(1);
    await new Promise((resolve) => setImmediate(resolve));
    chat.cleared_upto = 55;
    messages.value = new Map([[1, []]]);
    finish(old);
    await loading;
    assert.equal(messages.value.get(1)!.length, 0);
    assert.equal(hasOlder.value.get(1), false);
  });

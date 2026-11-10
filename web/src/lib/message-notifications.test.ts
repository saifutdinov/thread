import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

test('page notifications honor message mute and cooldown even before Web Audio is unlocked', async () => {
  for (const hide of [false, true]) {
    const shown: { silent: boolean }[] = [];
    const context = vm.createContext({
      pushSupported: true,
      nativeApp: undefined,
      Notification: { permission: 'granted' },
      audible: () => false,
      choices: { value: { message: 'chime' } },
      navigator: {
        serviceWorker: {
          getRegistration: async () => ({
            showNotification: async (_: string, options: { silent: boolean }) => {
              shown.push(options);
            },
          }),
        },
      },
      idbGet: async (key: string) => (key === 'hidePreview' ? hide : {}),
    });
    const source = readFileSync(new URL('./notify.ts', import.meta.url), 'utf8');
    const code = stripTypeScriptTypes(source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')).replace(/\bexport\s+/g, '');
    vm.runInContext(code + '\nglobalThis.notify=notifyMessage;', context);
    const notify = context.notify as (...args: unknown[]) => Promise<void>;
    await notify(1, 1, 'Alice', 'text', 'New message', 'Read', true);
    await notify(1, 2, 'Alice', 'text', 'New message', 'Read', false);
    assert.deepEqual(
      shown.map((n) => n.silent),
      [true, false],
    );
  }
});

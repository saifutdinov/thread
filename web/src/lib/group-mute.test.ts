import { NetworkPolicy, videoBudget } from './network-policy.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

test('releasing group push-to-talk during an async unmute keeps the new track silent', async () => {
  const source = readFileSync(new URL('./group.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')).replace(/\bexport\s+/g, '');
  const pending: (() => void)[] = [];
  const track = { enabled: false };
  const pub = { track: { mediaStreamTrack: track } };
  const participant = {
    isMicrophoneEnabled: false,
    getTrackPublication: () => pub,
    setMicrophoneEnabled: (on: boolean) =>
      new Promise<void>((resolve) =>
        pending.push(() => {
          participant.isMicrophoneEnabled = on;
          track.enabled = on;
          resolve();
        }),
      ),
  };
  const context = vm.createContext({
    signal: (value: unknown) => ({ value }),
    beginDiagnostics: () => ({ mark() {}, snapshot: () => [], finish() {} }),
    latest: (f: unknown) => f,
    setInterval: () => 0, clearInterval() {},
    NetworkPolicy, videoBudget, networkMode: {value:'auto'}, rememberNetworkMode() {},
    document: { createElement: () => ({ replaceChildren: () => {} }), body: { append: () => {} } },
    clearTimeout: () => {},
    socketHold: { call: true },
    releaseSocket: () => {},
    navigator: {},
    setGroupHandler: () => {},
    remembered: () => '',
    t: String,
    showToast: () => {},
    console,
  });
  vm.runInContext(
    code +
      '\nglobalThis.subject = {init(r) {room=r; lk={Track:{Source:{Microphone:"mic"}}}; groupCall.value={muted:true};}, setGroupMuted, groupCall, end};',
    context,
  );
  const s = (
    context as unknown as {
      subject: {
        init: (r: unknown) => void;
        setGroupMuted: (v: boolean) => Promise<void>;
        groupCall: { value: { muted: boolean } };
        end: () => void;
      };
    }
  ).subject;
  s.init({ localParticipant: participant });
  const press = s.setGroupMuted(false);
  const tick = () => new Promise<void>((r) => setImmediate(r));
  await tick();
  const release = s.setGroupMuted(true);
  pending.shift()!();
  await tick();
  assert.equal(track.enabled, false);
  pending.shift()!();
  await Promise.all([press, release]);
  assert.equal(track.enabled, false);
  assert.equal(s.groupCall.value.muted, true);

  // A permission prompt left pending in the old room must not block the
  // microphone queue of the next call, or update its view when it resolves.
  const old = s.setGroupMuted(false);
  await tick();
  s.end();
  const nextParticipant = {
    isMicrophoneEnabled: false,
    getTrackPublication: () => undefined,
    setMicrophoneEnabled: async (on: boolean) => {
      nextParticipant.isMicrophoneEnabled = on;
    },
  };
  s.init({ localParticipant: nextParticipant });
  let ready = false;
  const next = s.setGroupMuted(false).then(() => {
    ready = true;
  });
  await tick();
  assert.equal(ready, true);
  pending.shift()!();
  await Promise.all([old, next]);
  assert.equal(s.groupCall.value.muted, false);
});

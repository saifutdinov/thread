import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const Source = { Camera: 'camera', Microphone: 'mic', ScreenShare: 'screen', ScreenShareAudio: 'screen_audio' };

function subject() {
  const source = readFileSync(new URL('./group.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')).replace(/\bexport\s+/g, '');
  const context = vm.createContext({
    signal: (value: unknown) => ({ value }),
    document: { createElement: () => ({ append() {}, replaceChildren() {} }), body: { append() {} } },
    clearInterval,
    clearTimeout,
    remembered: () => '',
    navigator: {},
    setGroupHandler() {},
    latest: (f: unknown) => f,
    NetworkPolicy: class { observe() { return false; } reset() {} },
    testSource: Source,
  });
  vm.runInContext(
    code + '\nlk={Track:{Source:testSource}};globalThis.subject={setScreenVolume,setParticipantVolume,playRemote,end,screenVolumes,people,setRoom:(r)=>{room=r;}};',
    context,
  );
  return (context as unknown as { subject: Record<string, never> }).subject as unknown as {
    setScreenVolume: (id: string, v: number) => void;
    setParticipantVolume: (id: string, v: number) => void;
    playRemote: (track: unknown, pub: unknown, p: unknown) => void;
    end: () => void;
    screenVolumes: { value: Map<string, number> };
    people: (r: unknown) => { id: string; screenSound?: boolean }[];
    setRoom: (r: unknown) => void;
  };
}

const sound = { kind: 'audio', attach: () => ({}) };

function person(identity: string, published: string[] = []) {
  const calls: [number, string | undefined][] = [];
  return {
    identity,
    calls,
    setVolume: (v: number, source?: string) => calls.push([v, source]),
    getTrackPublication: (s: string) => (published.includes(s) ? { isMuted: false } : undefined),
  };
}

test('a shared screen has its own volume: the voice stays as it was', () => {
  const s = subject();
  const p = person('2.1.a');
  s.setRoom({ remoteParticipants: new Map([[p.identity, p]]) });
  s.setScreenVolume(p.identity, 0.3);
  assert.deepEqual(p.calls, [[0.3, Source.ScreenShareAudio]]);
  assert.equal(s.screenVolumes.value.get(p.identity), 0.3);
});

test('screen volume stays between 0 and 1', () => {
  const s = subject();
  s.setScreenVolume('2.1.a', 4);
  assert.equal(s.screenVolumes.value.get('2.1.a'), 1);
  s.setScreenVolume('2.1.a', -1);
  assert.equal(s.screenVolumes.value.get('2.1.a'), 0);
});

test('a track that arrives later gets both saved volumes, so a restarted share keeps its level', () => {
  const s = subject();
  const p = person('2.1.a');
  s.setParticipantVolume(p.identity, 0.8);
  s.setScreenVolume(p.identity, 0.2);
  s.playRemote(sound, {}, p);
  assert.deepEqual(p.calls, [[0.8, undefined], [0.2, Source.ScreenShareAudio]]);
});

test('without a saved level both play at full volume', () => {
  const s = subject();
  const p = person('2.1.a');
  s.playRemote(sound, {}, p);
  assert.deepEqual(p.calls, [[1, undefined], [1, Source.ScreenShareAudio]]);
});

test('a video track touches no volume', () => {
  const s = subject();
  const p = person('2.1.a');
  s.playRemote({ kind: 'video' }, {}, p);
  assert.deepEqual(p.calls, []);
});

test('the levels end with the call', () => {
  const s = subject();
  s.setScreenVolume('2.1.a', 0.2);
  s.end();
  assert.equal(s.screenVolumes.value.size, 0);
});

test('only a screen shared with sound offers the slider', () => {
  const s = subject();
  const local = person('1.1.me');
  const silent = person('2.1.a', [Source.ScreenShare]);
  const loud = person('3.1.b', [Source.ScreenShare, Source.ScreenShareAudio]);
  const list = s.people({ localParticipant: local, remoteParticipants: new Map([[silent.identity, silent], [loud.identity, loud]]) });
  assert.deepEqual([...list].map((x) => !!x.screenSound), [false, false, true]); // the list comes from another realm
});

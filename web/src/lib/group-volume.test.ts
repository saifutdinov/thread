import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { RemoteParticipant, Track } from 'livekit-client';

function fixture() {
  const source = readFileSync(new URL('./group.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export const participantVolumes');
  const end = source.indexOf('export async function exportGroupDiagnostics', start);
  const calls: { owner: string; track: string; volume: number }[] = [];
  const sdkCalls: { owner: string; source: string; volume: number }[] = [];
  const make = (identity: string) => {
    // Exercise the installed SDK's participant API and volume cache, rather
    // than a mock that treats every setVolume call as microphone volume.
    const participant = new RemoteParticipant({} as never, `PA_${identity}`, identity);
    const setVolume = participant.setVolume.bind(participant);
    participant.setVolume = (volume, source = Track.Source.Microphone) => {
      sdkCalls.push({ owner: identity, source, volume });
      setVolume(volume, source);
    };
    const publish = (name: string, source: Track.Source) => {
      let volume = 1;
      const track = {
        kind: 'audio', source, getVolume: () => volume,
        setVolume: (value: number) => { volume = value; calls.push({ owner: identity, track: name, volume: value }); },
        attach: () => ({ volume }),
      };
      const publication = { source, isMuted: false, track, audioTrack: track };
      participant.trackPublications.set(name, publication as never);
      participant.audioTrackPublications.set(name, publication as never);
      return track;
    };
    const remove = (name: string) => { participant.trackPublications.delete(name); participant.audioTrackPublications.delete(name); };
    publish('voice', Track.Source.Microphone);
    publish('screen', Track.Source.ScreenShareAudio);
    publish('music', Track.Source.Unknown);
    return { participant, publish, remove };
  };
  const first = make('2.1'), second = make('3.1');
  const participants = new Map([[first.participant.identity, first.participant], [second.participant.identity, second.participant]]);
  const context = vm.createContext({
    signal: (value: unknown) => ({ value }), room: { remoteParticipants: participants },
    lk: { Track }, audioBox: { append() {} }, remembered: () => '',
  });
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)).replace(/\bexport\s+/g, '') + '\nglobalThis.subject={setParticipantVolume,setScreenVolume,participantVolumes,screenVolumes,playRemote};', context);
  return { calls, sdkCalls, first, second, make, participants, subject: context.subject as {
    setParticipantVolume: (id: string, v: number) => void;
    setScreenVolume: (id: string, v: number) => void;
    playRemote: (track: unknown, pub: unknown, participant: RemoteParticipant) => void;
    participantVolumes: { value: Map<string, number> };
    screenVolumes: { value: Map<string, number> };
  } };
}

test('stream volume changes only that listener\'s selected participant screen/music, never the voice or another sender', () => {
  const h = fixture();
  h.subject.setScreenVolume('2.1', 0.25);
  assert.deepEqual(h.sdkCalls, [{ owner: '2.1', source: Track.Source.ScreenShareAudio, volume: 0.25 }]);
  assert.deepEqual(h.calls, [{ owner: '2.1', track: 'screen', volume: 0.25 }, { owner: '2.1', track: 'music', volume: 0.25 }]);
  h.calls.length = 0;
  h.subject.setParticipantVolume('2.1', 0.6);
  assert.deepEqual(h.calls, [{ owner: '2.1', track: 'voice', volume: 0.6 }]);
});

test('stream volume is reapplied to replacement tracks and rejects invalid input', () => {
  const h = fixture();
  h.subject.setScreenVolume('2.1', 0);
  h.calls.length = 0;
  const music = h.first.publish('music', Track.Source.Unknown);
  h.subject.playRemote(music, {}, h.first.participant);
  assert.equal(music.getVolume(), 0);
  assert.equal(h.first.participant.getVolume(Track.Source.Microphone), 1);
  assert.equal(h.first.participant.getVolume(Track.Source.ScreenShareAudio), 0);
  h.calls.length = 0;
  h.subject.setScreenVolume('2.1', NaN);
  h.subject.setScreenVolume('missing', 0.5);
  assert.deepEqual(h.calls, []);
  h.subject.setScreenVolume('2.1', 8);
  assert.ok(h.calls.every((c) => c.volume === 1));
});

test('screen volume uses the SDK cache even before the screen is published', () => {
  const h = fixture();
  h.first.remove('screen');
  h.subject.setScreenVolume('2.1', 0.2);
  assert.equal(h.first.participant.getVolume(Track.Source.ScreenShareAudio), 0.2);
  const screen = h.first.publish('screen', Track.Source.ScreenShareAudio);
  h.subject.playRemote(screen, {}, h.first.participant);
  assert.equal(screen.getVolume(), 0.2);
  assert.equal(h.first.participant.getVolume(), 1);
});

test('music published after a screen inherits the shared stream level without changing the voice', () => {
  const h = fixture();
  h.first.remove('music');
  h.subject.setParticipantVolume('2.1', 0.6);
  h.subject.setScreenVolume('2.1', 0.25);
  const music = h.first.publish('music', Track.Source.Unknown);
  h.subject.playRemote(music, {}, h.first.participant);
  assert.equal(music.getVolume(), 0.25);
  assert.equal(h.first.participant.getVolume(), 0.6);
  assert.equal(h.first.participant.getVolume(Track.Source.ScreenShareAudio), 0.25);
  assert.equal(h.second.participant.getVolume(), 1);
});

test('a new SDK participant after reconnect restores both caches even when music arrives first', () => {
  const h = fixture();
  h.subject.setParticipantVolume('2.1', 0.4);
  h.subject.setScreenVolume('2.1', 0);
  const replacement = h.make('2.1');
  replacement.remove('screen'); replacement.remove('voice');
  h.participants.set('2.1', replacement.participant);
  const music = replacement.publish('music', Track.Source.Unknown);
  h.subject.playRemote(music, {}, replacement.participant);
  assert.equal(replacement.participant.getVolume(), 0.4);
  assert.equal(replacement.participant.getVolume(Track.Source.ScreenShareAudio), 0);
  assert.equal(music.getVolume(), 0);
  const screen = replacement.publish('screen', Track.Source.ScreenShareAudio);
  const voice = replacement.publish('voice', Track.Source.Microphone);
  h.subject.playRemote(screen, {}, replacement.participant);
  h.subject.playRemote(voice, {}, replacement.participant);
  assert.equal(screen.getVolume(), 0);
  assert.equal(voice.getVolume(), 0.4);
});

test('only Unknown music gets direct fallback processing', () => {
  const h = fixture();
  const unrelated = h.first.publish('other', Track.Source.Camera);
  h.subject.setScreenVolume('2.1', 0.3);
  assert.equal(unrelated.getVolume(), 1);
});

test('invalid levels touch neither the SDK cache nor music, and histories stay bounded', () => {
  const h = fixture();
  for (const value of [NaN, Infinity, -Infinity]) {
    h.subject.setScreenVolume('2.1', value);
    h.subject.setParticipantVolume('2.1', value);
  }
  assert.deepEqual(h.calls, []); assert.deepEqual(h.sdkCalls, []);
  for (let i = 0; i < 110; i++) {
    const p = h.make(`device-${i}`);
    h.participants.set(p.participant.identity, p.participant);
    h.subject.setScreenVolume(p.participant.identity, 0);
    h.subject.setParticipantVolume(p.participant.identity, 0.5);
  }
  assert.equal(h.subject.screenVolumes.value.size, 100);
  assert.equal(h.subject.participantVolumes.value.size, 100);
});

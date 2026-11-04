import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const fixture = new URL('../.call-test-tools/stream-volume/', import.meta.url);
await mkdir(fixture, { recursive: true });
await writeFile(new URL('index.html', fixture), '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Stream volume check</title></head><body><div id="call"></div><script type="module" src="./entry.tsx"></script></body></html>');
await writeFile(new URL('entry.tsx', fixture), `
import { h, render } from 'preact';
import { signal } from '@preact/signals';
import { CallAudio, CallScreen, minimized } from '/src/components/Call.tsx';
import { call } from '/src/lib/call.ts';
import { voiceVolume } from '/src/lib/call-menu.ts';
import { RemoteParticipant, RemoteAudioTrack, Track } from 'livekit-client';
import { volumeTest, setParticipantVolume, setScreenVolume } from '/src/lib/group.ts';
import { lang } from '/src/lib/i18n.ts';
import '/src/styles.css';
lang.value = 'ru';
document.documentElement.dataset.theme = 'light';
const context = new AudioContext();
const voice = context.createMediaStreamDestination().stream;
const stream = context.createMediaStreamDestination().stream;
call.value = { id: 'volume-fixture', chat: 1, peer: 2, phase: 'active', video: false, muted: true, camOff: true, remote: voice, musicIn: stream, peerMusic: true };
const showScreen = signal(true);
function Fixture() { return <><CallAudio />{showScreen.value && <CallScreen />}</>; }
window.volumeFixture = { minimized, voice, stream, context, call, showScreen, voiceVolume, groupCheck };
render(h(Fixture), document.getElementById('call'));

// Real SDK participants/tracks and HTMLAudioElements; no media server is
// needed to test local playback levels. All synthetic output stays muted.
function groupCheck() {
  const owned = [];
  const participant = (id) => new RemoteParticipant({}, 'PA_' + id, id);
  const publish = (p, name, source) => {
    const raw = context.createMediaStreamDestination().stream.getAudioTracks()[0];
    const track = new RemoteAudioTrack(raw, 'TR_' + owned.length, {});
    track.source = source;
    const pub = { source, track, audioTrack: track };
    p.trackPublications.set(name, pub); p.audioTrackPublications.set(name, pub);
    owned.push(track);
    return track;
  };
  const attach = (p, track) => volumeTest.playRemote(track, {}, p);
  const level = (track) => track.attachedElements[0]?.volume;
  const p = participant('2.1'), other = participant('3.1');
  const participants = new Map([[p.identity, p], [other.identity, other]]);
  volumeTest.connect({ remoteParticipants: participants }, { Track });
  try {
    const voice = publish(p, 'voice', Track.Source.Microphone);
    const screen = publish(p, 'screen', Track.Source.ScreenShareAudio);
    const music = publish(p, 'music', Track.Source.Unknown);
    const otherVoice = publish(other, 'voice', Track.Source.Microphone);
    const otherScreen = publish(other, 'screen', Track.Source.ScreenShareAudio);
    for (const track of [voice, screen, music]) attach(p, track);
    for (const track of [otherVoice, otherScreen]) attach(other, track);
    setParticipantVolume(p.identity, 0.6); setScreenVolume(p.identity, 0.25);
    const initial = [voice, screen, music, otherVoice, otherScreen].map(level);
    setScreenVolume(p.identity, 0);
    const muted = [voice, screen, music, otherVoice, otherScreen].map(level);
    music.detach().forEach((el) => el.remove()); music.mediaStreamTrack.stop();
    const replacement = publish(p, 'music', Track.Source.Unknown);
    attach(p, replacement);
    const replaced = level(replacement);
    // A full reconnect makes a fresh participant. Music can arrive before
    // voice/screen publications; both standard SDK caches must already exist.
    for (const track of [voice, screen, replacement]) track.detach().forEach((el) => el.remove());
    const next = participant(p.identity); participants.set(next.identity, next);
    const nextMusic = publish(next, 'music', Track.Source.Unknown);
    attach(next, nextMusic);
    const cached = [next.getVolume(), next.getVolume(Track.Source.ScreenShareAudio)];
    const nextScreen = publish(next, 'screen', Track.Source.ScreenShareAudio);
    const nextVoice = publish(next, 'voice', Track.Source.Microphone);
    attach(next, nextScreen); attach(next, nextVoice);
    setScreenVolume(next.identity, Infinity);
    const reconnected = [nextVoice, nextScreen, nextMusic, otherVoice, otherScreen].map(level);
    return { initial, muted, replaced, cached, reconnected };
  } finally {
    volumeTest.connect(null, null);
    for (const track of owned) { track.detach().forEach((el) => el.remove()); track.mediaStreamTrack.stop(); }
  }
}
`);
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 },
  // A late dependency discovery can hot-reload a second Preact runtime while
  // the fixture is mounting. Keep the browser test's dependency graph stable.
  cacheDir: fileURLToPath(new URL('vite-cache/', fixture)),
  // Expose closure internals only in this fixture; production exports/bundles
  // keep the normal group.ts API.
  plugins: [{ name: 'group-volume-fixture', transform(code, id) {
    if (id.replaceAll('\\', '/').split('?')[0].endsWith('/src/lib/group.ts'))
      return code + '\nexport const volumeTest = {playRemote, connect: (r, sdk) => {room = r; lk = sdk;}};';
  } }],
  optimizeDeps: { noDiscovery: true, include: ['preact', 'preact/hooks', 'preact/jsx-runtime', 'preact/jsx-dev-runtime', 'preact/debug', 'preact/devtools', '@preact/signals', 'livekit-client'] },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ ...(process.env.BROWSER_BINARY ? { executablePath: process.env.BROWSER_BINARY } : {}), headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/.call-test-tools/stream-volume/index.html`);
  const slider = page.getByRole('slider', { name: 'Громкость стрима', exact: true });
  await slider.waitFor();
  await slider.evaluate((input) => { input.value = '0.25'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const volumes = () => page.evaluate(() => {
    const f = window.volumeFixture;
    const elements = [...document.querySelectorAll('audio')];
    return { voice: elements.find((el) => el.srcObject === f.voice)?.volume, stream: elements.find((el) => el.srcObject === f.stream)?.volume };
  });
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].find((el) => el.srcObject === window.volumeFixture.stream)?.volume === 0.25);
  assert.deepEqual(await volumes(), { voice: 1, stream: 0.25 });
  await page.getByRole('button', { name: 'Настройки звонка', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки звонка', exact: true });
  await settings.getByRole('slider', { name: 'Громкость стрима', exact: true }).evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].find((el) => el.srcObject === window.volumeFixture.stream)?.volume === 0);
  assert.deepEqual(await volumes(), { voice: 1, stream: 0 });
  await settings.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.evaluate(() => { window.volumeFixture.minimized.value = true; });
  await page.waitForFunction(() => !document.querySelector('dialog.call-screen'));
  assert.deepEqual(await volumes(), { voice: 1, stream: 0 });
  await page.evaluate(() => { window.volumeFixture.minimized.value = false; });
  await slider.waitFor();
  assert.equal(await slider.inputValue(), '0');
  assert.equal(await page.evaluate(() => localStorage.getItem('musicVolume')), '0');
  // The app lock unmounts the screen, but the audio at the root must stay.
  await page.evaluate(() => { window.volumeFixture.voiceVolume.value = 0.4; });
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].find((el) => el.srcObject === window.volumeFixture.voice)?.volume === 0.4);
  await page.evaluate(() => { window.volumeFixture.showScreen.value = false; });
  await page.waitForFunction(() => !document.querySelector('dialog.call-screen'));
  assert.deepEqual(await volumes(), { voice: 0.4, stream: 0 });
  await page.evaluate(() => { window.volumeFixture.showScreen.value = true; });
  await slider.waitFor();
  assert.equal(await slider.inputValue(), '0');
  assert.deepEqual(await volumes(), { voice: 0.4, stream: 0 });
  // A different call accepted behind the lock starts with its own voice level.
  await page.evaluate(() => { window.volumeFixture.showScreen.value = false; });
  await page.waitForFunction(() => !document.querySelector('dialog.call-screen'));
  await page.evaluate(() => {
    const f = window.volumeFixture;
    f.call.value = { ...f.call.value, id: 'next-locked-call' };
  });
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].find((el) => el.srcObject === window.volumeFixture.voice)?.volume === 1);
  assert.deepEqual(await volumes(), { voice: 1, stream: 0 });
  await page.evaluate(() => { window.volumeFixture.call.value = null; });
  assert.deepEqual(await page.evaluate(() => window.volumeFixture.groupCheck()), {
    initial: [0.6, 0.25, 0.25, 1, 1], muted: [0.6, 0, 0, 1, 1], replaced: 0,
    cached: [0.6, 0], reconnected: [0.6, 0, 0, 1, 1],
  });
  assert.deepEqual(errors, []);
  await page.evaluate(async () => { await window.volumeFixture.context.close(); });
  console.log('Stream volume UI, lock/remount and real LiveKit voice/screen/music playback, replacement and reconnect passed.');
} finally { await browser?.close(); await server.close(); }

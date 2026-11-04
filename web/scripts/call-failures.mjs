// Real browsers, real E2EE and a real SFU. No test endpoints in production.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = await realpath(os.tmpdir());
const dir = await mkdtemp(path.join(temporaryRoot, 'thread-calls-'));
const binary = path.join(dir, process.platform === 'win32' ? 'thread.exe' : 'connect');
const sfuBinary =
  process.env.LIVEKIT_BINARY ||
  fileURLToPath(new URL(`../.call-test-tools/livekit-server${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const cycles = Number(process.env.CALL_CYCLES || 3);
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 100, 'CALL_CYCLES must be 1..100');
const holdMs = Number(process.env.CALL_HOLD_MS || 1000);
assert.ok(Number.isFinite(holdMs) && holdMs >= 0 && holdMs <= 3_600_000, 'CALL_HOLD_MS must be 0..3600000');
const freePort = (protocol = 'tcp') =>
  new Promise((resolve, reject) => {
    const s = protocol === 'udp' ? dgram.createSocket('udp4') : net.createServer();
    s.on('error', reject);
    const ready = () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    };
    if (protocol === 'udp') {
      s.once('listening', ready);
      s.bind(0, '127.0.0.1');
    } else s.listen(0, '127.0.0.1', ready);
  });
const port = await freePort(),
  signalPort = await freePort(),
  mediaPort = await freePort('udp');
const base = `http://localhost:${port}`;
const contexts = [],
  processes = new Set(),
  errors = [];
let app,
  sfu,
  bootstrap,
  succeeded = false;
const logs = [];
function launch(exe, args, env = {}) {
  const p = spawn(exe, args, { cwd: repo, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(p);
  p.on('error', (e) => errors.push(e.message));
  for (const stream of [p.stdout, p.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop().slice(-16_384);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.url?.includes('/#/i/')) bootstrap = event.url;
        } catch {}
        if (/error|fatal/i.test(line)) {
          logs.push(line.replace(/https?:\/\/\S+/g, '[url]').slice(0, 400));
          if (logs.length > 50) logs.shift();
        }
      }
    });
  }
  p.once('exit', () => processes.delete(p));
  return p;
}
async function stop(p) {
  if (!p?.pid || p.exitCode !== null || p.signalCode !== null) return;
  const stopped = new Promise((resolve) => p.once('exit', resolve));
  p.kill('SIGKILL');
  await stopped;
}
let cleanupPromise;
function cleanup() {
  return (cleanupPromise ||= (async () => {
    await Promise.allSettled([...contexts.map((c) => c.close()), ...[...processes].map(stop)]);
  })());
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    console.error(`Interrupted by ${signal}; artifacts retained in ${dir}`);
    void cleanup().finally(() => process.exit(code));
  });
}
async function eventually(check, message, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await delay(100);
  }
  throw new Error(message);
}
async function startApp() {
  app = launch(binary, [], {
    ADDR: `127.0.0.1:${port}`,
    BASE_URL: base,
    DATA_DIR: path.join(dir, 'data'),
    STATIC_DIR: path.join(repo, 'web/dist'),
    PASSWORD_PEPPER: Buffer.alloc(32, 7).toString('base64'),
    LIVEKIT_URL: `http://127.0.0.1:${signalPort}`,
    LIVEKIT_KEY: 'test',
    LIVEKIT_SECRET: 'local-test-secret-with-at-least-32-bytes',
    TURN_SECRET: '',
    TURN_URLS: '',
    METRICS_ADDR: '',
    BACKUP_RECIPIENT: '',
    BACKUP_S3_ENDPOINT: '',
    BACKUP_S3_BUCKET: '',
    BACKUP_S3_ACCESS_KEY: '',
    BACKUP_S3_SECRET_KEY: '',
  });
  await eventually(async () => (await fetch(`${base}/healthz`)).ok, 'Thread did not start');
  console.log('READY Thread');
}
async function startSFU() {
  sfu = launch(sfuBinary, ['--config', path.join(dir, 'livekit.yml')]);
  await eventually(async () => (await fetch(`http://127.0.0.1:${signalPort}`)).ok, 'LiveKit did not start');
  console.log('READY LiveKit');
}
async function page() {
  const context = await chromium.launchPersistentContext(path.join(dir, `browser-${contexts.length}`), {
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      `--use-file-for-fake-video-capture=${path.join(dir, 'camera.y4m')}`,
    ],
    locale: 'ru-RU',
    permissions: ['camera', 'microphone'],
    serviceWorkers: 'block',
  });
  contexts.push(context);
  await context.addInitScript(() => {
    window.callTest = { tracks: [], peers: [], sockets: [], opens: 0 };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints);
      callTest.tracks.push(...stream.getTracks());
      return stream;
    };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) {
        super(...args);
        callTest.peers.push(this);
      }
    };
    const Socket = WebSocket;
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        callTest.sockets.push(this);
        this.addEventListener('open', () => callTest.opens++);
      }
    };
  });
  const p = context.pages()[0];
  p.setDefaultTimeout(20_000);
  p.on('pageerror', (error) => errors.push(error.message));
  return p;
}
async function register(p, link, name) {
  await p.goto(link);
  await p.getByLabel('Как вас зовут?', { exact: true }).fill(name);
  await p.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await p.getByLabel('Я записал(а) пароль', { exact: true }).check();
  await p.getByRole('button', { name: 'Продолжить', exact: true }).click();
  const done = p.getByRole('button', { name: 'Готово', exact: true });
  await done.waitFor();
  await done.click();
}
async function create(p, kind) {
  await p.goto(`${base}/#/new`);
  if (kind === 'group') {
    await p.getByRole('radio', { name: 'Группа', exact: true }).click();
    await p.getByLabel('Название группы', { exact: true }).fill('Call test');
  }
  await p.getByRole('button', { name: 'Создать приглашение', exact: true }).click();
  const invite = await p.locator('input.link-box[readonly]').inputValue();
  await p.getByRole('button', { name: 'Открыть чат', exact: true }).click();
  await p.waitForURL(/#\/c\/\d+$/);
  return { invite, url: p.url() };
}
const received = (p, video = false) =>
  p.evaluate(async (video) => {
    let bytes = 0;
    for (const peer of callTest.peers) {
      if (peer.connectionState !== 'connected') continue;
      for (const row of (await peer.getStats()).values()) {
        if (row.type === 'inbound-rtp' && row.kind === (video ? 'video' : 'audio'))
          bytes += Number(video ? row.framesDecoded : row.bytesReceived) || 0;
      }
    }
    return bytes;
  }, video);
async function flowing(p, video = false) {
  const before = await received(p, video);
  await eventually(async () => (await received(p, video)) > before, 'Remote media is not flowing', 45_000);
}
async function clean(p) {
  await p.waitForFunction(
    () => callTest.tracks.every((t) => t.readyState === 'ended') && callTest.peers.every((p) => p.connectionState === 'closed'),
  );
}
async function direct(a, b, video = false) {
  await a.getByRole('button', { name: video ? 'Видеозвонок' : 'Аудиозвонок', exact: true }).click();
  await b.getByRole('button', { name: video ? 'С видео' : 'Ответить', exact: true }).click();
  await Promise.all([flowing(a, video), flowing(b, video)]);
}
async function endDirect(a, b) {
  await a.getByRole('button', { name: 'Завершить', exact: true }).click();
  await b.locator('dialog.call-screen').waitFor({ state: 'detached' });
  await Promise.all([clean(a), clean(b)]);
}
async function encryptedTracks(p) {
  const { calls } = await p.evaluate(async () => (await fetch('/api/calls/group')).json());
  const c = calls[0];
  const room = `c${c.c}-${c.id}`;
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const payload = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'test', sub: 'fixture', exp: Math.floor(Date.now() / 1000) + 60, video: { room, roomAdmin: true } })}`;
  const token = payload + '.' + createHmac('sha256', 'local-test-secret-with-at-least-32-bytes').update(payload).digest('base64url');
  const res = await fetch(`http://127.0.0.1:${signalPort}/twirp/livekit.RoomService/ListParticipants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ room }),
  });
  assert.equal(res.status, 200);
  const { participants } = await res.json();
  const tracks = participants.flatMap((p) => p.tracks || []);
  assert.ok(tracks.length >= 4, 'two encrypted microphones and cameras must be published');
  assert.ok(
    tracks.every((t) => t.encryption === 'GCM' || t.encryption === 1),
    'the SFU must only receive GCM-encrypted media',
  );
}
async function scenario(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

try {
  execFileSync(process.env.GO_BINARY || 'go', ['build', '-o', binary, './cmd/thread'], { cwd: repo, windowsHide: true, stdio: 'inherit' });
  await mkdir(path.join(dir, 'data'));
  const frames = [Buffer.from('YUV4MPEG2 W320 H240 F10:1 Ip A1:1 C420jpeg\n')];
  for (let i = 0; i < 4; i++) frames.push(Buffer.from('FRAME\n'), Buffer.alloc(320 * 240, 50 + i * 45), Buffer.alloc((320 * 240) / 2, 128));
  await writeFile(path.join(dir, 'camera.y4m'), Buffer.concat(frames));
  await writeFile(
    path.join(dir, 'livekit.yml'),
    `port: ${signalPort}\nbind_addresses: [127.0.0.1]\nrtc:\n  node_ip: 127.0.0.1\n  use_external_ip: false\n  udp_port: ${mediaPort}\n  tcp_port: 0\nkeys:\n  test: local-test-secret-with-at-least-32-bytes\nlogging:\n  level: error\n`,
  );
  await startSFU();
  await startApp();
  await eventually(async () => !!bootstrap, 'No bootstrap invitation');
  const a = await page(),
    b = await page();
  await register(a, bootstrap, 'Test Alice');
  const chat = await create(a, 'direct');
  await register(b, chat.invite, 'Test Bob');
  await b.goto(chat.url);
  await scenario('audio/video decode and complete resource cleanup', async () => {
    await direct(a, b, true);
    await endDirect(a, b);
  });
  await scenario('Go crash/restart preserves direct media and restores signaling', async () => {
    await direct(a, b);
    const opens = await a.evaluate(() => callTest.opens);
    await stop(app);
    await Promise.all([flowing(a), flowing(b)]);
    await delay(1500);
    await startApp();
    await a.waitForFunction((n) => callTest.opens > n, opens);
    await endDirect(a, b);
  });
  await scenario('signaling-only offline does not tear down healthy WebRTC media', async () => {
    await direct(a, b);
    const opens = await a.evaluate(() => callTest.opens);
    await a.context().setOffline(true);
    await a.evaluate(() => callTest.sockets.filter((s) => s.url.includes('/api/ws')).forEach((s) => s.close()));
    await flowing(b);
    await a.context().setOffline(false);
    await a.waitForFunction((n) => callTest.opens > n, opens);
    await endDirect(a, b);
  });
  await scenario('late real media permission after cancellation closes its tracks', async () => {
    await a.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia;
      window.restoreCapture = () => {
        navigator.mediaDevices.getUserMedia = capture;
      };
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await capture(constraints);
        await new Promise((resolve) => {
          window.releaseCapture = resolve;
        });
        return stream;
      };
    });
    await a.getByRole('button', { name: 'Аудиозвонок', exact: true }).click();
    await a.waitForFunction(() => !!window.releaseCapture);
    await a.getByRole('button', { name: 'Завершить', exact: true }).click();
    await a.evaluate(() => {
      releaseCapture();
      restoreCapture();
    });
    await clean(a);
    assert.equal(await b.locator('dialog.call-screen').count(), 0);
  });
  await scenario(`${cycles} successive calls release every microphone and peer`, async () => {
    for (let i = 0; i < cycles; i++) {
      if (cycles > 3) await delay(10_100); // respect production offer rate limits
      await direct(a, b);
      await delay(holdMs);
      await endDirect(a, b);
    }
  });
  const group = await create(a, 'group');
  await b.goto(group.invite);
  await b.getByRole('button', { name: 'Присоединиться', exact: true }).click();
  await b.waitForURL(group.url);
  await scenario('real encrypted SFU media resumes after LiveKit is killed and restarted', async () => {
    await a.getByRole('button', { name: 'Групповой видеозвонок', exact: true }).click();
    await b.getByRole('button', { name: 'С видео', exact: true }).click();
    await Promise.all([flowing(a, true), flowing(b, true), flowing(a), flowing(b)]);
    await encryptedTracks(a);
    await stop(sfu);
    await delay(5000); // an actual media-server outage, not browser offline emulation
    await startSFU();
    await Promise.all([flowing(a, true), flowing(b, true), flowing(a), flowing(b)]);
    await encryptedTracks(a);
    for (const p of [a, b]) await p.getByRole('button', { name: 'Выйти', exact: true }).click();
    await Promise.all([clean(a), clean(b)]);
  });
  assert.deepEqual(errors, [], 'browser/process errors');
  succeeded = true;
} catch (e) {
  console.error(e);
  for (const [i, context] of contexts.entries())
    for (const p of context.pages()) {
      await p.screenshot({ path: path.join(dir, `page-${i}.png`) }).catch(() => {});
      console.error(
        'Browser state:',
        JSON.stringify(
          await p
            .evaluate(async () => ({
              text: document.body.innerText.slice(-250),
              captured: callTest.tracks.map((t) => ({ kind: t.kind, enabled: t.enabled, muted: t.muted, state: t.readyState })),
              stats: (
                await Promise.all(
                  callTest.peers.map(async (p) =>
                    [...(await p.getStats()).values()]
                      .filter((s) => s.type === 'inbound-rtp' || s.type === 'outbound-rtp')
                      .map((s) => ({
                        type: s.type,
                        kind: s.kind,
                        frames: s.framesEncoded || s.framesDecoded,
                        bytes: s.bytesSent || s.bytesReceived,
                      })),
                  ),
                )
              ).flat(),
              peers: callTest.peers.map((p) => ({
                connection: p.connectionState,
                ice: p.iceConnectionState,
                signaling: p.signalingState,
                tracks: p
                  .getTransceivers()
                  .map((t) => ({ kind: t.receiver.track.kind, direction: t.currentDirection, state: t.receiver.track.readyState })),
              })),
            }))
            .catch(() => ({})),
        ),
      );
    }
  console.error('Recent process errors:', logs.slice(-5));
  console.error(`Local test artifacts retained in ${dir}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  // Verify the resolved target before recursive Windows cleanup.
  if (succeeded && path.dirname(await realpath(dir)) === temporaryRoot && path.basename(dir).startsWith('thread-calls-'))
    await rm(dir, { recursive: true, force: true });
}

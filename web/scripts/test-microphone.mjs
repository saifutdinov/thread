// Real WASM and AudioWorklet in Chromium. Fake media is always muted.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, firefox } from 'playwright';

async function boundedEvaluate(page, fn, arg) {
  let timer;
  try {
    return await Promise.race([page.evaluate(fn, arg), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Microphone browser evaluation timed out')), 30000);
    })]);
  } finally { clearTimeout(timer); }
}

const fixture = new URL('../.call-test-tools/microphone/', import.meta.url);
await mkdir(fixture, { recursive: true });
await writeFile(new URL('index.html', fixture), '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Microphone check</title></head><body><div id="check"></div><script type="module" src="./entry.tsx"></script></body></html>');
await writeFile(new URL('entry.tsx', fixture), `
import { h, render } from 'preact';
import { DeviceCheck } from '/src/components/DeviceCheck.tsx';
import * as mic from '/src/lib/mic.ts';
import { lang } from '/src/lib/i18n.ts';
import '/src/styles.css';
lang.value = 'ru';
window.microphone = mic;
window.mountCheck = () => render(h(DeviceCheck, { onClose: () => render(null, document.getElementById('check')) }), document.getElementById('check'));
window.mountCheck();
`);
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0 },
  cacheDir: fileURLToPath(new URL('vite-cache/', fixture)),
  optimizeDeps: { noDiscovery: true, include: ['preact', 'preact/hooks', 'preact/jsx-runtime', 'preact/jsx-dev-runtime', 'preact/debug', 'preact/devtools', '@preact/signals', 'livekit-client'] },
  plugins: [{ name: 'microphone-test-csp', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws://${req.headers.host}; worker-src 'self'; object-src 'none'`);
      next();
    });
  } }],
});
let browser;
let inactiveBrowser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const isFirefox = process.env.BROWSER_ENGINE === 'firefox';
  browser = await (isFirefox ? firefox : chromium).launch({
    ...(!isFirefox && process.env.BROWSER_BINARY ? { executablePath: process.env.BROWSER_BINARY } : {}),
    headless: true,
    ...(isFirefox ? { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.volume_scale': '0.0', 'media.autoplay.default': 0 } }
      : { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] }),
  });
  const context = await browser.newContext({ ...(!isFirefox ? { permissions: ['microphone', 'camera'] } : {}), viewport: { width: 1100, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('callSpeaker', 'removed-test-speaker');
    window.testMedia = { tracks: [], contexts: [], audio: [], nodes: [], timings: [], overloaded: false };
    const Worklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Worklet {
      constructor(...args) { super(...args); window.testMedia.nodes.push({ node: this, name: args[1] }); this.port.addEventListener('message', ({data}) => { if(data.type === 'timings') { window.testMedia.timings.push(data); if(window.testMedia.timings.length > 10) window.testMedia.timings.shift(); } if(data.reason === 'overload') window.testMedia.overloaded = true; }); this.port.start(); }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await capture(...args);
      window.testMedia.tracks.push(...stream.getTracks());
      return stream;
    };
    const AudioContext = window.AudioContext;
    window.AudioContext = class extends AudioContext {
      constructor(...args) {
        super(...args);
        // The app keeps its notification-sound context alive after a click.
        if (!new Error().stack.includes('/src/lib/sounds.ts')) window.testMedia.contexts.push(this);
      }
    };
    const Audio = window.Audio;
    window.Audio = class extends Audio {
      constructor(...args) { super(...args); window.testMedia.audio.push(this); }
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  const external = [];
  page.on('request', (request) => { if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.text().startsWith('microphone-phase:')) console.log(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/.call-test-tools/microphone/index.html`);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForFunction(() => !!window.microphone);
  await page.getByRole('dialog', { name: 'Проверить устройства', exact: true }).locator('h2').click();
  const rnnoiseDelay = await page.evaluate(async () => {
    const { Rnnoise } = await import('/node_modules/@shiguredo/rnnoise-wasm/dist/rnnoise.js');
    const engine = (await Rnnoise.load()).createDenoiseState();
    const input = Float32Array.from({ length: 480 * 100 }, (_, i) => (Math.sin(i * 0.071 + 3 * Math.sin(i / 703)) + 0.3 * Math.sin(i * 0.223)) * (0.3 + 0.2 * Math.sin(i / 467)) * 12000);
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 480) {
      const frame = input.slice(i, i + 480); engine.processFrame(frame); output.set(frame, i);
    }
    engine.destroy();
    let best = -Infinity, delay = 0;
    for (let lag = 0; lag <= 1920; lag++) {
      let score = 0;
      for (let i = 10000; i < input.length; i++) score += output[i] * input[i - lag];
      if (score > best) { best = score; delay = lag; }
    }
    return delay;
  });
  assert.ok(Math.abs(rnnoiseDelay - 960) <= 2, `unexpected real RNNoise model delay ${rnnoiseDelay}`);
  console.log(`Measured RNNoise model delay: ${rnnoiseDelay} samples`);
  // Verify both actual models load, then exercise their shared outgoing track.
  for (const model of ['rnnoise', 'deepfilter', 'browser', 'off']) {
    // PCM correctness uses a loaded model; cold-start timing is a separate
    // regression. Firefox's compiler can legitimately exceed the call budget.
    if (model === 'deepfilter') await boundedEvaluate(page, async () => {
      window.microphone.setMicSettings({ model: 'deepfilter' });
      await window.microphone.loadDeepfilter();
    });
    const result = await boundedEvaluate(page, async (model) => {
      const mic = window.microphone; window.testMedia.overloaded = false;
      mic.setMicSettings({ model, strength: 0.65, gain: 0, gate: -70 });
      console.log('microphone-phase: ' + model + ' capture');
      const capture = await navigator.mediaDevices.getUserMedia({ audio: mic.micConstraints() });
      const captureRate = capture.getAudioTracks()[0].getSettings().sampleRate;
      console.log('microphone-phase: ' + model + ' prepare');
      const own = await mic.openMic(capture.getAudioTracks()[0], undefined, 'preview');
      const ctx = new AudioContext({ sampleRate: own.sampleRate ?? own.track.getSettings().sampleRate });
      console.log('microphone-phase: ' + model + ' analyse');
      if (!await mic.resumeMicContext(ctx)) throw new Error('Analysis AudioContext remained suspended');
      const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
      ctx.createMediaStreamSource(new MediaStream([own.track])).connect(analyser);
      const data = new Float32Array(2048);
      // Wait for real audio callbacks, bounded by the test runner's timeout.
      let peak = 0;
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        analyser.getFloatTimeDomainData(data);
        peak = Math.max(peak, ...data.map(Math.abs));
      }
      const nativeRateFallback = /Firefox\//.test(navigator.userAgent) && (model === 'rnnoise' || model === 'deepfilter') && captureRate && captureRate !== 48000;
      const result = { model, captureRate, nativeRateFallback: !!nativeRateFallback, failed: mic.micFailure.value, processed: own.track !== own.raw, peak, overloaded: window.testMedia.overloaded, constraints: own.raw.getConstraints() };
      own.close(); await ctx.close();
      return result;
    }, model);
    console.log(JSON.stringify(result));
    assert.ok(!result.failed || (model === 'deepfilter' && result.overloaded), `${model}: processing failed`);
    assert.equal(result.processed, !result.nativeRateFallback && (model === 'rnnoise' || model === 'deepfilter'), `${model}: unexpected graph`);
    assert.ok(Number.isFinite(result.peak) && result.peak > 0, `${model}: no finite output`);
    assert.equal(result.constraints.noiseSuppression, model === 'browser' || result.nativeRateFallback);
  }
  for (const failure of ['message', 'processor']) {
    const recovered = await boundedEvaluate(page, async (failure) => {
      const mic = window.microphone;
      mic.setMicSettings({ model: 'rnnoise', gain: 0, gate: -70, highPass: false });
      const source = new AudioContext({ sampleRate: 48000 });
      if (!await mic.resumeMicContext(source)) throw new Error('Source AudioContext remained suspended');
      const destination = source.createMediaStreamDestination();
      const oscillator = source.createOscillator(); oscillator.connect(destination); oscillator.start();
      const own = await mic.openMic(destination.stream.getAudioTracks()[0]);
      const node = window.testMedia.nodes.findLast((n) => n.name === 'thread-rnnoise').node;
      const ctx = new AudioContext({ sampleRate: 48000 });
      if (!await mic.resumeMicContext(ctx)) throw new Error('Analysis AudioContext remained suspended');
      const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
      ctx.createMediaStreamSource(new MediaStream([own.track])).connect(analyser);
      own.raw.enabled = own.track.enabled = false;
      const fail = () => failure === 'message'
        ? node.port.dispatchEvent(new MessageEvent('message', { data: { type: 'error' } }))
        : node.onprocessorerror(new Event('processorerror'));
      fail(); fail();
      const muted = !own.raw.enabled && !own.track.enabled;
      own.raw.enabled = own.track.enabled = true;
      const data = new Float32Array(2048); let peak = 0;
      for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 40)); analyser.getFloatTimeDomainData(data); peak = Math.max(peak, ...data.map(Math.abs)); }
      const result = { muted, live: own.track.readyState === 'live', failed: mic.micFailure.value, peak };
      own.close(); await ctx.close(); await source.close(); return result;
    }, failure);
    assert.equal(recovered.muted, true); assert.equal(recovered.live, true); assert.equal(recovered.failed, true);
    assert.ok(recovered.peak > 0, `${failure}: runtime failure silenced output`);
  }
  console.log('DFN3 inference timings:', await page.evaluate(() => window.testMedia.timings));
  // Settings UI and monitor lifecycle use the same output and no auto playback.
  await page.evaluate(() => window.microphone.setMicSettings({ model: 'rnnoise' }));
  await page.getByRole('button', { name: 'Начать проверку', exact: true }).click();
  await page.getByRole('button', { name: 'Слушать себя', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Слушать себя' && !b.disabled));
  assert.equal(await page.evaluate(() => window.testMedia.audio.some((a) => a.srcObject && !a.paused)), false);
  await page.getByRole('button', { name: 'Слушать себя', exact: true }).click();
  await page.getByRole('button', { name: 'Остановить прослушивание', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.testMedia.audio.find((a) => a.srcObject && !a.paused)?.volume), 0.25);
  await page.getByLabel('Шумодав', { exact: true }).selectOption('deepfilter');
  await page.waitForFunction(() => !document.querySelector('.mic-tuning').disabled);
  await page.getByRole('button', { name: 'Остановить прослушивание', exact: true }).waitFor();
  await page.getByText('Дополнительные настройки', { exact: true }).click();
  await page.getByLabel('Усиление микрофона', { exact: false }).evaluate((input) => { input.value = '6'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.screenshot({ path: fileURLToPath(new URL('preview.png', fixture)), fullPage: true });
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.waitForFunction(() => window.testMedia.tracks.every((t) => t.readyState === 'ended') && window.testMedia.contexts.every((c) => c.state === 'closed') && window.testMedia.audio.every((a) => !a.srcObject));
  // A permission answer arriving after the dialog closes must release the capture.
  await page.evaluate(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await capture(...args);
      await new Promise((resolve) => { window.releasePermission = resolve; });
      return stream;
    };
    window.mountCheck();
  });
  await page.getByRole('checkbox', { name: 'Камера', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Начать проверку', exact: true }).click();
  await page.waitForFunction(() => !!window.releasePermission);
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.evaluate(() => window.releasePermission());
  await page.waitForFunction(() => window.testMedia.tracks.every((t) => t.readyState === 'ended'));
  // A failed model download explicitly falls back to native suppression.
  const fallback = await context.newPage();
  await fallback.route('**/*df_bg*.wasm*', (route) => route.request().resourceType() === 'fetch' ? route.abort() : route.continue());
  await fallback.goto(`http://127.0.0.1:${port}/.call-test-tools/microphone/index.html`);
  await fallback.waitForFunction(() => !!window.microphone);
  await fallback.getByRole('dialog', { name: 'Проверить устройства', exact: true }).locator('h2').click();
  const recovered = await fallback.evaluate(async () => {
    const mic = window.microphone;
    mic.setMicSettings({ model: 'deepfilter' });
    const original = (await navigator.mediaDevices.getUserMedia({ audio: mic.micConstraints() })).getAudioTracks()[0];
    const own = await mic.openMic(original);
    const result = { fallback: own.track === own.raw, warned: mic.micFailure.value, originalEnded: original.readyState === 'ended', suppression: own.raw.getConstraints().noiseSuppression };
    own.close();
    return result;
  });
  assert.deepEqual(recovered, { fallback: true, warned: true, originalEnded: false, suppression: true });
  await fallback.close();
  // Closing during the model download cannot reopen the microphone as fallback.
  const cancelled = await context.newPage();
  let download;
  const pendingDownload = new Promise((resolve) => { download = resolve; });
  let releaseDownload;
  const release = new Promise((resolve) => { releaseDownload = resolve; });
  await cancelled.route('**/*df_bg*.wasm*', async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    download(); await release; await route.abort();
  });
  await cancelled.goto(`http://127.0.0.1:${port}/.call-test-tools/microphone/index.html`);
  await cancelled.waitForFunction(() => !!window.microphone);
  await cancelled.getByRole('dialog', { name: 'Проверить устройства', exact: true }).locator('h2').click();
  await cancelled.evaluate(async () => {
    const mic = window.microphone;
    mic.setMicSettings({ model: 'deepfilter' });
    window.cancelledRaw = (await navigator.mediaDevices.getUserMedia({ audio: mic.micConstraints() })).getAudioTracks()[0];
    window.micController = new AbortController();
    window.pendingMic = mic.openMic(window.cancelledRaw, window.micController.signal).then((own) => { own.close(); window.micCancelled = false; }, (error) => { window.micCancelled = error.name === 'AbortError'; });
  });
  await pendingDownload;
  await cancelled.evaluate(() => window.micController.abort());
  try {
    await cancelled.waitForFunction(() => window.micCancelled === true && window.testMedia.tracks.every((t) => t.readyState === 'ended') && window.testMedia.contexts.every((c) => c.state === 'closed'), null, { timeout: 2000 });
  } finally { releaseDownload(); }
  const afterCancel = await cancelled.evaluate(async () => {
    await window.pendingMic;
    return { captures: window.testMedia.tracks.length, ended: window.testMedia.tracks.every((t) => t.readyState === 'ended') };
  });
  assert.deepEqual(afterCancel, { captures: 1, ended: true });
  await cancelled.close();
  if (!isFirefox) {
    // Unlike the DSP fixture, this browser has normal autoplay policy and no
    // clicks. A notification-style capture must never construct a context.
    inactiveBrowser = await chromium.launch({ ...(process.env.BROWSER_BINARY ? { executablePath: process.env.BROWSER_BINARY } : {}), headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
    const inactiveContext = await inactiveBrowser.newContext({ permissions: ['microphone'] });
    const inactive = await inactiveContext.newPage();
    await inactive.goto(`http://127.0.0.1:${port}/.call-test-tools/microphone/index.html`);
    // Playwright evaluate itself supplies a gesture. CDP must explicitly omit
    // it, otherwise the regression silently tests an already activated page.
    const session = await inactiveContext.newCDPSession(inactive);
    const probe = async () => {
      let contexts = 0; const Original = window.AudioContext;
      window.AudioContext = class extends Original { constructor(...args) { super(...args); contexts++; } };
      const mic = window.microphone; mic.setMicSettings({ model: 'rnnoise' });
      const raw = (await navigator.mediaDevices.getUserMedia({ audio: mic.micConstraints() })).getAudioTracks()[0];
      const own = await mic.openMic(raw);
      const result = { active: navigator.userActivation.hasBeenActive, contexts, direct: own.track === raw, warned: mic.micFailure.value, suppression: raw.getConstraints().noiseSuppression };
      own.close(); return result;
    };
    const evaluated = await session.send('Runtime.evaluate', { expression: `(${probe.toString()})()`, awaitPromise: true, returnByValue: true, userGesture: false });
    assert.equal(evaluated.exceptionDetails, undefined);
    assert.deepEqual(evaluated.result.value, { active: false, contexts: 0, direct: true, warned: false, suppression: true });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], 'audio check must not use any external service');
  console.log('Microphone models, monitor, live settings and cancelled permissions passed.');
} finally {
  await browser?.close();
  await inactiveBrowser?.close();
  await server.close();
}

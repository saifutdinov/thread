import assert from 'node:assert/strict';
import { test } from 'node:test';

let change = () => {};
const page: { requestFullscreen?: () => Promise<void> } = {
  requestFullscreen: async () => {
    doc.fullscreenElement = page;
    change();
  },
};
const doc = {
  fullscreenElement: null as unknown,
  documentElement: page,
  addEventListener: (_: string, fn: () => void) => (change = fn),
  exitFullscreen: async () => {
    exits++;
    doc.fullscreenElement = null;
    change();
  },
};
let exits = 0;
Object.assign(globalThis, { document: doc });
const { fullscreen, setFullscreen } = await import('./fullscreen.ts');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the page goes full screen and the state follows the browser, Escape included', async () => {
  setFullscreen(true);
  await tick();
  assert.equal(fullscreen.value, true);
  doc.fullscreenElement = null; // Escape: the browser leaves by itself
  change();
  assert.equal(fullscreen.value, false);
});

test('leaving when nothing is full screen asks the browser for nothing', () => {
  exits = 0;
  setFullscreen(false);
  assert.equal(exits, 0);
});

test('a refusal or a browser without the API is no error: the call keeps its window', async () => {
  const request = page.requestFullscreen;
  page.requestFullscreen = () => Promise.reject(new TypeError('denied'));
  setFullscreen(true);
  await tick();
  page.requestFullscreen = undefined; // iPhone
  setFullscreen(true);
  page.requestFullscreen = request;
  assert.equal(fullscreen.value, false);
});

test('leaving while the browser is still entering leaves as soon as it lands', async () => {
  let land = () => {};
  const request = page.requestFullscreen;
  page.requestFullscreen = () => new Promise((resolve) => {
    land = () => {
      doc.fullscreenElement = page;
      change();
      resolve();
    };
  });
  exits = 0;
  setFullscreen(true);
  setFullscreen(false); // a double click, or the sharer stopped
  land();
  await tick();
  page.requestFullscreen = request;
  assert.equal(exits, 1);
  assert.equal(fullscreen.value, false);
});

test('a video in its own full screen is not ours to leave', () => {
  doc.fullscreenElement = {};
  exits = 0;
  setFullscreen(false);
  doc.fullscreenElement = null;
  assert.equal(exits, 0);
});


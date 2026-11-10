// The bridge between the page and the app, in the page's isolated world. It
// speaks the browser extension's messages (desktop/extension/content.js), so
// the web code finds push-to-talk the same way in both.
const { contextBridge, ipcRenderer } = require('electron');

const version = (process.argv.find((a) => a.startsWith('--app-version=')) ?? '').slice('--app-version='.length);
contextBridge.exposeInMainWorld('connectApp', {
  version,
  platform: process.platform,
  show: () => ipcRenderer.send('show'),
  notify: (note) => ipcRenderer.send('notify', note),
  clear: (tag) => ipcRenderer.send('notify:clear', tag),
  onOpen: (open) => ipcRenderer.on('open', (_e, url) => open(url)),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});

const send = (message) => window.postMessage({ ...message, source: 'thread-ptt-extension' }, location.origin);
let available = false;
ipcRenderer.on('talk', (_e, m) => send(m));
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || e.data?.source !== 'thread-ptt' || !available) return;
  if (e.data.type === 'probe') return send({ status: 'available' });
  if (e.data.type === 'configure') {
    ipcRenderer.send('talk', {
      type: 'configure',
      binding: e.data.binding,
      enabled: e.data.enabled === true,
      connect: e.data.connect === true,
      session: e.data.session,
    });
  }
});
void ipcRenderer.invoke('talk:available').then((yes) => {
  available = yes === true;
  if (available) send({ status: 'available' });
});

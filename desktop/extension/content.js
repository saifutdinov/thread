// Only the configured Thread origin can use this bridge.
const allowed = new Set(globalThis.THREAD_PTT_ORIGINS);
if (allowed.has(location.origin)) {
  const send = (message) => window.postMessage({ ...message, source: 'thread-ptt-extension' }, location.origin);
  let port = null;
  const connect = () => {
    if (port) return port;
    const p = chrome.runtime.connect({ name: 'thread-ptt' });
    port = p;
    p.onMessage.addListener((m) => {
      if (port === p) send(m);
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== p) return;
      port = null;
      send({ status: 'error', type: 'state', down: false });
    });
    return p;
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || e.data?.source !== 'thread-ptt') return;
    if (e.data.type === 'probe') return send({ status: 'available' });
    if (e.data.type === 'configure') {
      if (!e.data.connect && !port) return;
      try {
        connect().postMessage({
          type: 'configure',
          binding: e.data.binding,
          enabled: e.data.enabled === true,
          connect: e.data.connect === true,
          session: e.data.session,
        });
      } catch {
        const p = port;
        port = null;
        try {
          p?.disconnect();
        } catch {}
        send({ status: 'error', type: 'state', down: false });
      }
      if (!e.data.connect && port) {
        const p = port;
        port = null;
        try {
          p.disconnect();
        } catch {}
      }
    }
  });
  send({ status: 'available' });
}

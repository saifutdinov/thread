importScripts('origins.js');
const allowed = new Set(globalThis.THREAD_PTT_ORIGINS);
const ports = new Set();
let lastBinding = null,
  bindingAt = 0;
let native = null,
  owner = null;
function release(port, status = 'ready') {
  try {
    port?.postMessage({ type: 'state', down: false, status });
  } catch {}
}
function connectNative() {
  if (native) return native;
  const n = chrome.runtime.connectNative('ru.thread.hotkeys');
  let ready = false;
  native = n;
  n.onMessage.addListener((m) => {
    if (native !== n) return;
    if (m.type === 'ready') {
      if (m.version !== 1) return n.disconnect();
      ready = true;
      for (const p of ports) p.postMessage({ status: 'ready' });
    }
    if (ready && m.type === 'state' && typeof m.down === 'boolean' && typeof m.session === 'string')
      owner?.postMessage({ type: 'state', down: m.down, session: m.session, status: 'ready' });
  });
  n.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (native !== n) return;
    native = null;
    for (const p of ports) release(p, 'error');
    owner = null;
  });
  return n;
}
chrome.runtime.onConnect.addListener((p) => {
  let origin;
  try {
    origin = new URL(p.sender?.url).origin;
  } catch {
    return p.disconnect();
  }
  if (p.name !== 'thread-ptt' || !allowed.has(origin) || p.sender?.frameId !== 0) return p.disconnect();
  ports.add(p);
  p.onMessage.addListener((m) => {
    if (m.type !== 'configure' || typeof m.session !== 'string' || m.session.length > 64) return;
    if (owner && owner !== p) return release(p, 'busy');
    if (!m.connect && !native) return;
    // Enforce this across native-host restarts and across tabs, not only
    // inside one process. A page cannot rapidly scan arbitrary key codes.
    const binding = JSON.stringify([m.binding?.code, m.binding?.ctrl, m.binding?.alt, m.binding?.shift, m.binding?.meta]);
    if (binding !== lastBinding) {
      if (lastBinding !== null && Date.now() - bindingAt < 1000) {
        if (owner === p) {
          const n = native;
          native = null;
          owner = null;
          n?.disconnect();
        }
        return release(p, 'error');
      }
      lastBinding = binding;
      bindingAt = Date.now();
    }
    const n = connectNative();
    if (m.enabled) owner = p;
    n.postMessage({ type: 'configure', binding: m.binding, enabled: m.enabled === true, session: m.session });
    if (!m.enabled && owner === p) owner = null;
    if (!m.connect) {
      native = null;
      n.disconnect();
      release(p, 'available');
    }
  });
  p.onDisconnect.addListener(() => {
    ports.delete(p);
    if (owner === p) {
      owner = null;
      const n = native;
      native = null;
      n?.disconnect();
    }
    if (!ports.size) {
      const n = native;
      native = null;
      n?.disconnect();
    }
  });
});

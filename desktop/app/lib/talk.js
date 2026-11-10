// Talk stands in for the browser extension (desktop/extension): it carries
// push-to-talk between the page and the thread-hotkeys companion. The page
// speaks the same messages as with the extension, so web code is unchanged.
// The same guards apply: version 1 only, and a page cannot scan keys by
// changing the binding faster than once a second.
export class Talk {
  host = null;
  ready = false;
  binding = null;
  bindingAt = 0;

  constructor({ start, toPage, clock = Date.now }) {
    this.start = start;
    this.toPage = toPage;
    this.clock = clock;
  }

  fromPage(m) {
    if (m?.type !== 'configure' || typeof m.session !== 'string' || m.session.length > 64) return;
    if (!m.connect && !this.host) return;
    const binding = JSON.stringify([m.binding?.code, m.binding?.ctrl, m.binding?.alt, m.binding?.shift, m.binding?.meta]);
    if (binding !== this.binding) {
      if (this.binding !== null && this.clock() - this.bindingAt < 1000) {
        this.stop();
        return this.toPage({ type: 'state', down: false, status: 'error' });
      }
      this.binding = binding;
      this.bindingAt = this.clock();
    }
    if (!this.host) {
      this.host = this.start();
      this.ready = false;
    }
    this.host?.send({ type: 'configure', binding: m.binding, enabled: m.enabled === true, session: m.session });
    if (!m.connect) {
      this.stop();
      this.toPage({ type: 'state', down: false, status: 'available' });
    }
  }

  fromHost(m) {
    if (m?.type === 'ready') {
      if (m.version !== 1) return this.stop();
      this.ready = true;
      return this.toPage({ status: 'ready' });
    }
    if (this.ready && m?.type === 'state' && typeof m.down === 'boolean' && typeof m.session === 'string') {
      this.toPage({ type: 'state', down: m.down, session: m.session, status: 'ready' });
    }
  }

  // The companion exited or broke its framing: the key is released.
  hostGone() {
    this.host = null;
    this.ready = false;
    this.toPage({ type: 'state', down: false, status: 'error' });
  }

  stop() {
    const host = this.host;
    this.host = null;
    this.ready = false;
    host?.stop();
  }
}

import { FrameBuffer } from './denoise-frame.js';

export class DenoiseProcessor extends AudioWorkletProcessor {
  constructor(options, model) {
    super();
    this.model = model;
    this.frames = new FrameBuffer(model);
    this.strength = options.processorOptions.strength;
    this.ready = false;
    this.closed = false;
    this.failed = false;
    this.elapsed = new Float32Array(64);
    this.slow = new Uint8Array(16);
    this.frameCount = 0;
    this.clock = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'close') { this.closed = true; this.engine?.destroy(); this.engine = null; }
      if (data.type === 'strength' && Number.isFinite(data.value)) {
        this.strength = Math.max(0, Math.min(1, data.value));
        this.engine?.setAttenuationLimit?.(this.strength * 60);
      }
    };
    this.processFrame = (frame) => {
      if (this.model === 'rnnoise') {
        for (let i = 0; i < 480; i++) frame[i] *= 32768;
        this.engine.processFrame(frame);
        for (let i = 0; i < 480; i++) frame[i] /= 32768;
      } else {
        const start = this.clock();
        frame.set(this.engine.process(frame));
        const elapsed = Math.max(0, this.clock() - start);
        this.elapsed[this.frameCount % 64] = elapsed;
        // Ignore initial JIT warmup. Sustained inference overruns trigger the
        // same audible bypass as a model error, rather than continued glitches.
        this.slow[this.frameCount % 16] = this.frameCount >= 32 && elapsed > this.budget ? 1 : 0;
        this.frameCount++;
        if (this.frameCount % 64 === 0) this.reportTimings();
        if (this.slow.reduce((sum, value) => sum + value, 0) >= 12) {
          this.reportTimings();
          this.fail('overload');
        }
      }
    };
  }
  start(promise) {
    promise.then((engine) => {
      if (this.closed) { engine.destroy(); return; }
      this.engine = engine;
      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    }).catch(() => this.fail());
  }
  reportTimings() {
    const times = [...this.elapsed].slice(0, Math.min(this.frameCount, 64)).sort((a, b) => a - b);
    this.port.postMessage({ type: 'timings', frames: this.frameCount, meanMs: times.reduce((s, n) => s + n, 0) / times.length,
      p95Ms: times[Math.floor((times.length - 1) * 0.95)], maxMs: times.at(-1), budgetMs: this.budget });
  }
  fail(reason = 'model') {
    if (this.failed) return;
    this.failed = true;
    this.ready = false;
    this.port.postMessage({ type: 'error', reason });
  }
  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (this.closed) return false;
    if (!inputs[0]?.[0] || !output) return true;
    this.budget = output.length / sampleRate * 1000;
    if (!this.ready) { output.set(inputs[0][0]); return true; }
    try { this.frames.render(inputs[0][0], output, this.processFrame, this.strength); }
    catch { output.set(inputs[0][0]); this.fail(); }
    return true;
  }
}

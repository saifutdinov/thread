// Fixed 480-sample adapter: 128-sample callbacks never drop or reorder samples.
// RNNoise v0.2 has 960 samples of model delay (STFT + delayed_X).
export class FrameBuffer {
  constructor(model) {
    this.model = model;
    this.position = 0;
    this.input = new Float32Array(480);
    this.work = new Float32Array(480);
    this.output = new Float32Array(480);
    this.previous = new Float32Array(960);
  }
  render(input, output, processFrame, strength) {
    for (let i = 0; i < output.length; i++) {
      const p = this.position;
      output[i] = this.output[p];
      this.input[p] = Number.isFinite(input[i]) ? input[i] : 0;
      if (++this.position !== 480) continue;
      this.position = 0;
      this.work.set(this.input);
      processFrame(this.work);
      const dry = this.model !== 'rnnoise' || strength >= 1 ? 0 : strength <= 0 ? 1 : 10 ** (-2 * strength);
      for (let j = 0; j < 480; j++) {
        const sample = this.work[j] * (1 - dry) + this.previous[j] * dry;
        this.output[j] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      }
      this.previous.copyWithin(0, 480);
      this.previous.set(this.input, 480);
    }
  }
}

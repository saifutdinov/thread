// The voice gate: sound quieter than the threshold is not sent. It runs on
// the audio thread, so a hidden tab gates like a visible one. The level is
// the RMS of each 128-sample block in dB; at the threshold's minimum the
// gate never closes. It opens in 5 ms, holds through the pauses between
// words and fades out, so it neither clicks nor clips syllables.
const HOLD_S = 0.3;
const OFF = -100;

class VoiceGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: OFF, minValue: OFF, maxValue: 0, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.gain = 1;
    this.left = 0; // samples the gate stays open
    this.blocks = 0;
    this.watch = false; // post the level for the meter
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.005));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.05));
    this.port.onmessage = (e) => (this.watch = e.data === true);
  }

  process(inputs, outputs, params) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const db = 10 * Math.log10(sum / input.length + 1e-12);
    const threshold = params.threshold[0];
    if (threshold <= OFF || db > threshold) this.left = HOLD_S * sampleRate;
    else this.left = Math.max(0, this.left - input.length);
    const target = this.left > 0 ? 1 : 0;
    const k = target > this.gain ? this.attack : this.release;
    for (let i = 0; i < input.length; i++) {
      this.gain += (target - this.gain) * k;
      if (this.gain < 1e-4 && !target) this.gain = 0; // -80 dB: cut, not a fade forever
      output[i] = input[i] * this.gain;
    }
    if (this.watch && ++this.blocks % 8 === 0) this.port.postMessage(db);
    return true;
  }
}

registerProcessor('voice-gate', VoiceGate);

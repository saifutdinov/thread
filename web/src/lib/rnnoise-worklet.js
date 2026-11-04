import { Rnnoise } from '@shiguredo/rnnoise-wasm';
import { DenoiseProcessor } from './denoise-processor.js';

class RnnoiseProcessor extends DenoiseProcessor {
  constructor(options) {
    super(options, 'rnnoise');
    this.start(Rnnoise.load().then((rn) => rn.createDenoiseState()));
  }
}
registerProcessor('thread-rnnoise', RnnoiseProcessor);

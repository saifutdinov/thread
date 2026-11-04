import { DeepFilter } from '@lofcz/deepfilternet-web';
import { DenoiseProcessor } from './denoise-processor.js';

class DeepFilterProcessor extends DenoiseProcessor {
  constructor(options) {
    super(options, 'deepfilter');
    // A compiled module crosses the structured-clone boundary; no fetch in a worklet.
    this.start(DeepFilter.create({ wasmUrl: { module_or_path: options.processorOptions.wasmModule }, attenuationLimit: this.strength * 60 }));
  }
}
registerProcessor('thread-deepfilter', DeepFilterProcessor);

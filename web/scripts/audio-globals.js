// AudioWorkletGlobalScope lacks TextDecoder. WASM bindings use it for diagnostics.
// Emscripten's browser build checks this name before using its embedded WASM.
globalThis.WorkerGlobalScope ??= class {};
globalThis.TextDecoder ??= class {
  decode(bytes = new Uint8Array()) {
    let text = '';
    for (let i = 0; i < bytes.length;) {
      const a = bytes[i++];
      if (a < 128) text += String.fromCharCode(a);
      else if (a < 224) text += String.fromCharCode(((a & 31) << 6) | (bytes[i++] & 63));
      else if (a < 240) text += String.fromCharCode(((a & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else text += String.fromCodePoint(((a & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    }
    return text;
  }
};

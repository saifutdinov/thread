// face.ts loads MediaPipe's face detector. Imported only by effects.ts, on
// demand: the engine is 13.5 MB of WebAssembly (2.7 MB over the wire with
// brotli, see scripts/brotli.mjs), all served from this site.
import { FaceDetector } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
// BlazeFace short range, float16 v1 (Apache-2.0), sha256 b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f,
// from storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/
import modelAssetPath from '../assets/blaze_face_short_range.tflite?url';

let ready: Promise<FaceDetector> | null = null;

export function detector(): Promise<FaceDetector> {
  ready ??= FaceDetector.createFromOptions(
    { wasmLoaderPath, wasmBinaryPath },
    // The CPU: BlazeFace is tiny, and Safari's GPU path fails on some iPhones.
    { baseOptions: { modelAssetPath, delegate: 'CPU' }, runningMode: 'VIDEO', minDetectionConfidence: 0.5 },
  ).catch((e) => {
    ready = null; // a failed load may be retried
    throw e;
  });
  return ready;
}

// face.ts loads MediaPipe's vision tasks for call effects: the face
// landmarker (478 points and expressions) and the person segmenter (for
// the background). Imported only by effects.ts, on demand: the engine is
// 13.5 MB of WebAssembly (2.7 MB over the wire with brotli, see
// scripts/brotli.mjs), the models 3.8 MB and 0.25 MB, all from this site.
import { FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
// Face landmarker float16 v1 (Apache-2.0), sha256 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff,
// from storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/
import faceModel from '../assets/face_landmarker.task?url';
// Selfie segmenter float16 v1 (Apache-2.0), sha256 191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b,
// from storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/
import personModel from '../assets/selfie_segmenter.tflite?url';

const files = { wasmLoaderPath, wasmBinaryPath };

// Limit: both stay loaded for the life of the page (a second open is
// instant); close() them when memory on old phones turns out tight.
let faces: Promise<FaceLandmarker> | null = null;
let person: Promise<ImageSegmenter> | null = null;

// The CPU everywhere: Safari's GPU path fails on some iPhones. Two faces:
// a family call often has two people in the picture.
export function landmarker(): Promise<FaceLandmarker> {
  faces ??= FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: faceModel, delegate: 'CPU' },
    runningMode: 'VIDEO',
    numFaces: 2,
    outputFaceBlendshapes: true,
  }).catch((e) => {
    faces = null; // a failed load may be retried
    throw e;
  });
  return faces;
}

export function segmenter(): Promise<ImageSegmenter> {
  person ??= ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: personModel, delegate: 'CPU' },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  }).catch((e) => {
    person = null;
    throw e;
  });
  return person;
}

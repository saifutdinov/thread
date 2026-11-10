import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { nativeApp } from '../lib/pwa';
import { fmtDuration } from '../lib/recorder';
import { showToast } from '../lib/store';
import { IconButton, Modal } from './ui';

// Our own camera, the first tile of the attach sheet on phones: a tap takes
// a photo, holding records a video until released, a button turns between
// the back and front cameras, another the flash where the camera has one.
// The shot goes to the composer's attachments like a picked file.
const HOLD_MS = 300;
// 6 Mbit/s of video and 128 kbit/s of sound: a minute fits the 50 MB limit.
const VIDEO_BPS = 6_000_000;
const VIDEO_MAX_MS = 60_000;

type Facing = 'environment' | 'user';
interface Capture {
  takePhoto(settings?: { fillLightMode?: 'off' | 'flash' }): Promise<Blob>;
  getPhotoCapabilities(): Promise<{ fillLightMode?: string[] }>;
}
const ImageCaptureCtor = (globalThis as { ImageCapture?: new (track: MediaStreamTrack) => Capture }).ImageCapture;

function videoType(): string {
  const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return types.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
}

export function Camera(props: { onShot: (file: File) => void; onClose: () => void }) {
  const [facing, setFacing] = useState<Facing>('environment');
  const [flash, setFlash] = useState(false);
  const [canFlash, setCanFlash] = useState(false);
  const [recording, setRecording] = useState(false);
  const [ms, setMs] = useState(0);
  const view = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  const hasTorch = useRef(false);
  // The front camera's flash: a ring of light around the screen, as from a
  // ring lamp, with the screen at full brightness in the Android app.
  const ring = flash && facing === 'user';
  useEffect(() => {
    nativeApp?.brightness?.(ring);
    return () => nativeApp?.brightness?.(false);
  }, [ring]);
  const gone = useRef(false); // closed: a shot still finishing is dropped, not attached
  useEffect(() => () => void (gone.current = true), []);

  // The camera at its sharpest, with the microphone for videos.
  useEffect(() => {
    let live = true;
    const video = { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 } };
    navigator.mediaDevices
      .getUserMedia({ video, audio: true })
      .catch(() => navigator.mediaDevices.getUserMedia({ video })) // no microphone: photos and silent videos
      .then(async (s) => {
        if (!live) return s.getTracks().forEach((tr) => tr.stop());
        stream.current = s;
        if (view.current) view.current.srcObject = s;
        const track = s.getVideoTracks()[0];
        const torch = !!(track.getCapabilities?.() as { torch?: boolean } | undefined)?.torch;
        hasTorch.current = torch;
        const photoFlash = ImageCaptureCtor
          ? await new ImageCaptureCtor(track).getPhotoCapabilities().then((c) => !!c.fillLightMode?.includes('flash'), () => false)
          : false;
        if (live) setCanFlash(facing === 'user' || torch || photoFlash);
      })
      .catch(() => {
        if (gone.current) return;
        showToast(t('camera.denied'));
        props.onClose();
      });
    return () => {
      live = false;
      recorder.current?.state === 'recording' && recorder.current.stop();
      stream.current?.getTracks().forEach((tr) => tr.stop());
      stream.current = null;
    };
  }, [facing]);

  useEffect(() => {
    if (!recording) return;
    const start = Date.now();
    const timer = setInterval(() => {
      setMs(Date.now() - start);
      if (Date.now() - start >= VIDEO_MAX_MS) stopVideo();
    }, 200);
    return () => clearInterval(timer);
  }, [recording]);

  const track = () => stream.current?.getVideoTracks()[0];
  const torch = (on: boolean) => track()?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }).catch(() => {});

  async function photo() {
    const tr = track();
    if (!tr || busy.current) return;
    busy.current = true;
    // A frame of the stream, the way it is seen (not mirrored).
    const frame = () => {
      const v = view.current!;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      return new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.95));
    };
    try {
      let blob: Blob | null = null;
      const rear = facing === 'environment';
      if (flash && rear && hasTorch.current) {
        // The flash as a torch: on, a moment for the exposure to settle, the
        // frame, off. ImageCapture's own flash does not fire in Android's WebView.
        await torch(true);
        await new Promise((ok) => setTimeout(ok, 600));
        blob = await frame();
        void torch(false);
      } else {
        // ImageCapture (Chrome on Android): the sensor's full resolution.
        if (ImageCaptureCtor) blob = await new ImageCaptureCtor(tr).takePhoto(flash && rear ? { fillLightMode: 'flash' } : {}).catch(() => null);
        blob ??= await frame();
      }
      if (blob && !gone.current) props.onShot(new File([blob], `photo-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' }));
    } finally {
      busy.current = false;
    }
  }

  function startVideo() {
    const s = stream.current;
    if (!s || typeof MediaRecorder === 'undefined') return;
    const mimeType = videoType();
    const r = new MediaRecorder(s, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      void torch(false);
      setRecording(false);
      const type = (r.mimeType || mimeType || 'video/webm').split(';')[0];
      const blob = new Blob(chunks, { type });
      if (blob.size && !gone.current) props.onShot(new File([blob], `video-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type }));
    };
    if (flash && facing === 'environment') void torch(true);
    r.start(1000);
    recorder.current = r;
    setMs(0);
    setRecording(true);
  }

  function stopVideo() {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
  }

  return (
    <Modal label={t('camera.title')} onClose={props.onClose} class="camera-modal">
      <div class="camera">
        <video ref={view} class={facing === 'user' ? 'mirror' : ''} autoPlay muted playsInline />
        {ring && <div class="ring-light" aria-hidden="true" />}
        <div class="camera-top">
          <IconButton icon="close" label={t('common.close')} onClick={props.onClose} />
          {recording && <span class="camera-time">{fmtDuration(ms)}</span>}
          {canFlash && (
            <IconButton icon="bolt" label={t(flash ? 'camera.flashOff' : 'camera.flashOn')} class={flash ? 'on' : ''} aria-pressed={flash} onClick={() => setFlash(!flash)} />
          )}
        </div>
        <div class="camera-bottom">
          <span class="camera-hint">{recording ? t('camera.release') : t('camera.hint')}</span>
          <button
            type="button"
            class={'shutter' + (recording ? ' recording' : '')}
            aria-label={t('camera.shoot')}
            onContextMenu={(e) => e.preventDefault()} // a long press is a video, not a menu
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              hold.current = setTimeout(() => {
                hold.current = undefined;
                startVideo();
              }, HOLD_MS);
            }}
            onPointerUp={() => {
              if (hold.current) {
                clearTimeout(hold.current);
                hold.current = undefined;
                void photo();
              } else stopVideo();
            }}
            onPointerCancel={() => {
              clearTimeout(hold.current);
              hold.current = undefined;
              stopVideo();
            }}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void photo())}
          />
          <IconButton
            icon="flip"
            label={t('camera.flip')}
            disabled={recording}
            onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')}
          />
        </div>
      </div>
    </Modal>
  );
}

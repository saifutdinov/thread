// Voice messages and video circles, recorded with MediaRecorder. The file
// is encrypted like any attachment; the waveform travels inside the
// encrypted message, so the server learns nothing but a blob size.

// mp4/AAC first: Safari and current Chrome record it and every browser
// plays it. webm/opus is the fallback for Firefox and older Chrome.
const AUDIO = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
const VIDEO = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export const VOICE_MAX_MS = 5 * 60e3;
export const VIDEO_MAX_MS = 60e3;

// The record button is held: dragged up past LOCK_PX it locks (keeps
// recording without the finger), left past CANCEL_PX it throws the
// recording away. dx, dy in px from where the press began.
const LOCK_PX = 80;
const CANCEL_PX = 120;
export function dragAction(dx: number, dy: number): 'lock' | 'cancel' | null {
  if (-dy > LOCK_PX && -dy >= -dx) return 'lock';
  if (-dx > CANCEL_PX) return 'cancel';
  return null;
}

export interface Recorded {
  blob: Blob;
  mime: string;
  d: number; // duration, ms
  wf: number[]; // voice only: 48 bars, 0..31
}

export interface Recording {
  stream: MediaStream;
  level(): number; // 0..1, for the live meter
  elapsed(): number;
  alive(): boolean; // false once the recorder stopped on its own
  stop(): Promise<Recorded>;
  cancel(): void;
}

// waveform squeezes level samples into `bars` peaks scaled to 0..31.
export function waveform(samples: number[], bars = 48): number[] {
  if (!samples.length) return new Array(bars).fill(0);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i * samples.length) / bars);
    const b = Math.max(a + 1, Math.floor(((i + 1) * samples.length) / bars));
    let m = 0;
    for (let j = a; j < b && j < samples.length; j++) m = Math.max(m, samples[j]);
    out.push(m);
  }
  const peak = Math.max(...out, 1e-3);
  return out.map((v) => Math.round(31 * Math.min(1, v / peak)));
}

export function openStream(kind: 'audio' | 'video', facing: 'user' | 'environment' = 'user'): Promise<MediaStream> {
  const audio = { echoCancellation: true, noiseSuppression: true };
  return navigator.mediaDevices.getUserMedia(
    kind === 'audio'
      ? { audio }
      : { audio, video: { facingMode: facing, width: { ideal: 480 }, height: { ideal: 480 }, aspectRatio: { ideal: 1 } } },
  );
}

// startRecording records an open stream. For voice, pass an AudioContext
// created inside the tap itself: iOS keeps one made later suspended, which
// would leave the level meter and the waveform flat.
export function startRecording(stream: MediaStream, kind: 'audio' | 'video', ctx?: AudioContext): Recording {
  const types = (kind === 'audio' ? AUDIO : VIDEO).filter((t) => MediaRecorder.isTypeSupported(t));
  const chunks: Blob[] = [];
  let failure = '';
  let rec!: MediaRecorder;
  let mime: string | undefined;

  // Chrome rejects an explicit audio bitrate for AAC (EncodingError right
  // after start): mp4 gets the browser default, opus a modest rate. A
  // recorder that still fails in its first seconds is restarted with the
  // next format, dropping whatever it managed to write.
  const begin = (i: number) => {
    const started = performance.now();
    mime = types[i];
    const aac = !!mime?.includes('mp4');
    const opts: MediaRecorderOptions = { mimeType: mime };
    if (kind === 'video') opts.videoBitsPerSecond = 1_000_000;
    if (!aac) opts.audioBitsPerSecond = kind === 'audio' ? 48_000 : 64_000;
    try {
      rec = new MediaRecorder(stream, mime ? opts : undefined);
    } catch {
      rec = new MediaRecorder(stream);
    }
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onerror = (e) => {
      if (performance.now() - started < 2000 && i + 1 < types.length) {
        rec.onstop = null;
        chunks.length = 0;
        begin(i + 1);
        return;
      }
      failure = (e as Event & { error?: DOMException }).error?.name ?? 'error';
    };
    rec.start(250);
  };

  let level = () => 0;
  const samples: number[] = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  if (ctx) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    level = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) * 3);
    };
    sampler = setInterval(() => samples.push(level()), 100);
  }
  const t0 = performance.now();
  begin(0);

  const release = () => {
    clearInterval(sampler);
    stream.getTracks().forEach((tr) => tr.stop());
    ctx?.close().catch(() => {});
  };
  return {
    stream,
    level: () => level(),
    elapsed: () => performance.now() - t0,
    alive: () => rec.state !== 'inactive',
    cancel() {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
    // stop never hangs and never fails silently: a recorder that already
    // stopped on its own (mic unplugged, encoder error) still yields what
    // it captured, and an empty result is an error the UI shows.
    stop: () =>
      new Promise((resolve, reject) => {
        const d = Math.round(performance.now() - t0);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          release();
          const type = rec.mimeType || mime || (kind === 'audio' ? 'audio/webm' : 'video/webm');
          const blob = new Blob(chunks, { type });
          // A failed encoder may leave a broken file: an error beats sending it.
          if (failure || !blob.size) return reject(new Error(failure || 'empty recording'));
          resolve({ blob, mime: type, d, wf: kind === 'audio' ? waveform(samples) : [] });
        };
        if (rec.state === 'inactive') return finish();
        const timer = setTimeout(finish, 3000);
        rec.onstop = () => {
          clearTimeout(timer);
          finish();
        };
        try {
          rec.stop();
        } catch {
          clearTimeout(timer);
          finish();
        }
      }),
  };
}

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

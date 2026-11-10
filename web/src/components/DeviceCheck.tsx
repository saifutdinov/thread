import { useEffect, useRef, useState } from 'preact/hooks';
import { cameras, microphones, speakers, deviceName, refreshDevices, remember, remembered } from '../lib/devices';
import { t } from '../lib/i18n';
import { call } from '../lib/call';
import { groupCall } from '../lib/group';
import { canTune, micConstraints, openMic, resumeMicContext, type Mic } from '../lib/mic';
import { MicTuning } from './MicTuning';
import { showToast } from '../lib/store';
import { Modal } from './ui';

function tone() {
  const n = 8000;
  const data = new ArrayBuffer(44 + n * 2);
  const v = new DataView(data);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, data.byteLength - 8, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++)
    v.setInt16(44 + i * 2, 1500 * Math.sin((2 * Math.PI * 440 * i) / 16000) * Math.min(1, i / 300, (n - i) / 300), true);
  return new Blob([data], { type: 'audio/wav' });
}

// A local preview only: nothing is published or sent to the server. Every
// replacement, close and late permission result closes its own resources.
export function DeviceCheck(props: { onClose: () => void }) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [withCamera, setWithCamera] = useState(true);
  const [listening, setListening] = useState(false);
  // The microphone and speaker are tried here only: a call starts on the
  // system's own (call.ts). The camera is remembered for calls.
  const [choice, setChoice] = useState({ callMic: '', callCam: remembered('callCam'), callSpeaker: '' });
  const generation = useRef(0);
  const media = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const processed = useRef<Mic | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const monitor = useRef<HTMLAudioElement | null>(null);
  const meter = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const sound = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stopSound = () => {
    const s = sound.current;
    if (s) {
      s.audio.pause();
      URL.revokeObjectURL(s.url);
      sound.current = null;
    }
  };
  const stop = (keepCamera = false) => {
    generation.current++;
    preparation.current?.abort(); preparation.current = null;
    if (monitor.current) { monitor.current.pause(); monitor.current.srcObject = null; monitor.current = null; }
    setListening(false);
    processed.current?.close();
    processed.current = null;
    const camera = keepCamera ? media.current?.getVideoTracks()[0] : undefined;
    media.current?.getTracks().forEach((tr) => { if (tr !== camera) tr.stop(); });
    media.current = camera ? new MediaStream([camera]) : null;
    clearInterval(meter.current);
    void context.current?.close().catch(() => {});
    context.current = null;
  };
  useEffect(() => {
    void refreshDevices();
    return () => {
      stop();
      stopSound();
    };
  }, []);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);
  const open = async (resumeListening = false, keepCamera = false) => {
    // Tuning the microphone must not close/reopen the camera device. It stays
    // owned by media.current, including while the next audio permission waits.
    stop(keepCamera);
    const camera = media.current?.getVideoTracks()[0];
    setStream(null);
    setLevel(0);
    setBusy(true);
    const my = generation.current;
    const controller = new AbortController(); preparation.current = controller;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(choice.callMic ? { ideal: choice.callMic } : undefined),
        video: withCamera && !camera ? (choice.callCam ? { deviceId: { ideal: choice.callCam } } : { facingMode: 'user' }) : false,
      });
      if (generation.current !== my) {
        s.getTracks().forEach((tr) => tr.stop());
        return;
      }
      if (camera) s.addTrack(camera);
      media.current = s;
      void refreshDevices();
      const mic = await openMic(s.getAudioTracks()[0], controller.signal, 'preview');
      if (generation.current !== my) { mic.close(); s.getTracks().forEach((tr) => tr.stop()); return; }
      processed.current = mic;
      mic.raw.addEventListener('ended', () => { if (generation.current === my) { stop(); setStream(null); setLevel(0); } }, { once: true });
      const ctx = new AudioContext({ sampleRate: mic.sampleRate ?? mic.track.getSettings().sampleRate });
      context.current = ctx;
      if (!await resumeMicContext(ctx, controller.signal)) throw new Error('audio');
      if (generation.current !== my) return;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const source = ctx.createMediaStreamSource(new MediaStream([mic.track]));
      source.connect(analyser);
      const delay = ctx.createDelay(0.5); delay.delayTime.value = 0.15;
      const destination = ctx.createMediaStreamDestination();
      source.connect(delay).connect(destination);
      const audio = new Audio();
      audio.volume = 0.25;
      audio.srcObject = destination.stream;
      monitor.current = audio;
      if (choice.callSpeaker && 'setSinkId' in audio) {
        try { await audio.setSinkId(choice.callSpeaker); }
        catch { if (generation.current === my) showToast(t('mic.outputFallback')); }
      }
      if (generation.current !== my) return;
      setStream(s);
      if (resumeListening) { await audio.play(); if (generation.current !== my) return; setListening(true); }
      const samples = new Uint8Array(analyser.fftSize);
      meter.current = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        setLevel(Math.min(1, Math.sqrt(samples.reduce((n, x) => n + ((x - 128) / 128) ** 2, 0) / samples.length) * 4));
      }, 100);
    } catch {
      if (generation.current === my) {
        stop();
        setStream(null);
        setBusy(false);
        showToast(t('call.noMedia'));
      }
    } finally {
      if (preparation.current === controller) preparation.current = null;
      if (generation.current === my) setBusy(false);
    }
  };
  const listen = async () => {
    const audio = monitor.current;
    if (!audio) return;
    if (listening) { audio.pause(); setListening(false); return; }
    const my = generation.current;
    try { await audio.play(); if (generation.current === my) setListening(true); }
    catch { if (generation.current === my) showToast(t('call.noMedia')); }
  };
  const close = () => {
    stop();
    stopSound();
    props.onClose();
  };
  const play = async () => {
    stopSound();
    const url = URL.createObjectURL(tone());
    const audio = new Audio(url);
    sound.current = { audio, url };
    audio.onended = () => {
      if (sound.current?.audio === audio) stopSound();
    };
    try {
      if (choice.callSpeaker && 'setSinkId' in audio) await audio.setSinkId(choice.callSpeaker);
      if (sound.current?.audio === audio) await audio.play();
    } catch {
      if (sound.current?.audio === audio) {
        stopSound();
        showToast(t('call.noMedia'));
      }
    }
  };
  return (
    <Modal label={t('call.deviceCheck')} onClose={close} class="device-check">
      <h2>{t('call.deviceCheck')}</h2>
      <p class="muted small">{t('call.deviceCheckHint')}</p>
      {(
        [
          ['callMic', microphones(), 'call.audio.mic'],
          ['callCam', cameras(), 'call.audio.camera'],
          ['callSpeaker', speakers(), 'call.audio.out'],
        ] as const
      ).map(
        ([key, list, label]) =>
          list.length > 0 && (
            <label class="field" key={key}>
              <span>{t(label)}</span>
              <select
                value={choice[key]}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  if (key === 'callCam') remember(key, id);
                  setChoice({ ...choice, [key]: id });
                  stop();
                  setStream(null);
                  setBusy(false);
                  setLevel(0);
                  stopSound();
                }}
              >
                <option value="">{t('call.systemDefault')}</option>
                {list.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {deviceName(d, i)}
                  </option>
                ))}
              </select>
            </label>
          ),
      )}
      <label class="row">
        <input
          type="checkbox"
          checked={withCamera}
          onChange={(e) => {
            setWithCamera(e.currentTarget.checked);
            stop();
            setStream(null);
            setBusy(false);
          }}
        />
        {t('call.audio.camera')}
      </label>
      {stream?.getVideoTracks().length ? (
        <video
          ref={video}
          class={'cam-preview' + (stream.getVideoTracks()[0].getSettings().facingMode === 'environment' ? '' : ' mirror')}
          autoPlay
          playsInline
          muted
        />
      ) : null}
      <label class="field">
        <span>{t('call.micLevel')}</span>
        <meter min="0" max="1" value={level} aria-label={t('call.micLevel')} />
      </label>
      {canTune && <MicTuning disabled={busy} reopen={async () => { if (media.current) await open(listening, true); }} />}
      <button
        type="button"
        class="btn secondary"
        disabled={busy}
        onClick={() => (stream ? (stop(), setStream(null), setLevel(0)) : void open())}
      >
        {t(stream ? 'call.checkStop' : 'call.checkStart')}
      </button>
      <button type="button" class="btn secondary" disabled={!stream || busy} aria-pressed={listening} onClick={() => void listen()}>
        {t(listening ? 'mic.listenStop' : 'mic.listen')}
      </button>
      <p class="muted small" role="status">{t(listening ? 'mic.listening' : 'mic.listenHint')}</p>
      <button type="button" class="btn secondary" onClick={() => void play()}>
        {t('call.testSpeaker')}
      </button>
      <button type="button" class="btn" onClick={close}>
        {t('common.done')}
      </button>
    </Modal>
  );
}

export function DeviceCheckButton() {
  const [open, setOpen] = useState(false);
  const inCall = !!call.value || !!groupCall.value;
  useEffect(() => {
    if (inCall) setOpen(false);
  }, [inCall]);
  return (
    <>
      <button type="button" class="btn secondary" disabled={inCall} onClick={() => setOpen(true)}>
        {t('call.deviceCheck')}
      </button>
      {open && !inCall && <DeviceCheck onClose={() => setOpen(false)} />}
    </>
  );
}

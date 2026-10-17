import { useEffect, useRef, useState } from 'preact/hooks';
import { errText, t } from '../lib/i18n';
import { cameras, refreshDevices } from '../lib/devices';
import { fmtDuration, fmtSize, openStream, type Recording, startRecording, VIDEO_MAX_MS } from '../lib/recorder';
import { type Attachment, mediaUrl, type Outgoing, showToast } from '../lib/store';
import { Icon, IconButton, Modal } from './ui';

// One sound at a time: starting a player pauses the previous one.
let active: HTMLMediaElement | null = null;
function claim(el: HTMLMediaElement) {
  if (active && active !== el) active.pause();
  active = el;
}

// useDecrypted fetches and decrypts an attachment once it scrolls near
// the viewport, so a long chat does not download every recording.
function useDecrypted(a: Attachment) {
  const ref = useRef<HTMLElement>(null);
  const [url, setUrl] = useState<string>();
  const want = useRef(false);
  const load = () => {
    if (want.current) return;
    want.current = true;
    mediaUrl(a).then(setUrl, () => (want.current = false));
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && load(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [a.id]);
  return { ref, url, load };
}

export function VoicePlayer(props: { a: Attachment }) {
  const { a } = props;
  const { ref, url, load } = useDecrypted(a);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [rate, setRate] = useState(1);
  const [real, setReal] = useState(0); // the file's own duration, once known
  const d = real || a.d || 0;
  const bars = a.wf?.length ? a.wf : new Array(48).fill(4);

  const toggle = () => {
    const el = audio.current;
    if (!el || !url) return load();
    if (el.paused) {
      claim(el);
      el.playbackRate = rate;
      el.play().catch(() => {});
    } else el.pause();
  };
  const seek = (e: MouseEvent) => {
    const el = audio.current;
    if (!el || !url) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    el.currentTime = (Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d) / 1000;
  };
  const progress = d ? pos / d : 0;

  return (
    <div class="voice" ref={ref as never}>
      <button type="button" class="voice-play" onClick={toggle} aria-label={playing ? t('play.pause') : t('play.play')}>
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <div class="voice-body">
        <div class="voice-wave" onClick={seek} aria-hidden="true">
          {bars.map((v, i) => (
            <i key={i} class={i / bars.length < progress ? 'on' : ''} style={{ height: `${3 + (v / 31) * 19}px` }} />
          ))}
        </div>
        <div class="voice-meta">
          <span>{fmtDuration(playing || pos ? pos : d)}</span>
          <button
            type="button"
            class="voice-rate"
            aria-label={t('play.speed')}
            onClick={() => {
              const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
              setRate(next);
              if (audio.current) audio.current.playbackRate = next;
            }}
          >
            {rate}x
          </button>
        </div>
      </div>
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPos(0);
          }}
          onTimeUpdate={(e) => setPos(e.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setReal(e.currentTarget.duration * 1000)}
        />
      )}
    </div>
  );
}

export function VideoNote(props: { a: Attachment }) {
  const { a } = props;
  const { ref, url, load } = useDecrypted(a);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const pending = useRef(false);

  useEffect(() => {
    // Tapped before the file arrived: start as soon as it is there.
    if (url && pending.current && video.current) {
      pending.current = false;
      claim(video.current);
      video.current.play().catch(() => {});
    }
  }, [url]);

  const toggle = () => {
    const el = video.current;
    if (!el || !url) {
      pending.current = true;
      return load();
    }
    if (el.paused) {
      claim(el);
      el.play().catch(() => {});
    } else el.pause();
  };
  const R = 48;
  const C = 2 * Math.PI * R;

  return (
    <button type="button" class="circle-note" ref={ref as never} onClick={toggle} aria-label={playing ? t('play.pause') : t('att.video')}>
      {a.th && <img src={a.th} alt="" class="thumb" />}
      {url && (
        <video
          ref={video}
          src={url}
          playsInline
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || (a.d ?? 1) / 1000))}
        />
      )}
      <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={R} stroke-dasharray={C} stroke-dashoffset={C * (1 - progress)} />
      </svg>
      {!playing && (
        <span class="circle-play">
          <Icon name="play" />
        </span>
      )}
      <span class="circle-time">{fmtDuration(playing ? progress * (a.d ?? 0) : (a.d ?? 0))}</span>
    </button>
  );
}

// VideoClip is a video from the gallery: decrypted only when tapped (it
// can be tens of megabytes), then played by the browser's own player.
export function VideoClip(props: { a: Attachment }) {
  const { a } = props;
  const [url, setUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      setUrl(await mediaUrl(a));
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const ratio = { aspectRatio: `${a.w || 16} / ${a.h || 9}` };
  return url ? (
    <video class="clip" style={ratio} src={url} controls autoPlay playsInline onPlay={(e) => claim(e.currentTarget)} />
  ) : (
    <button type="button" class="clip" style={ratio} onClick={open} disabled={busy} aria-label={`${t('att.clip')}, ${fmtDuration(a.d ?? 0)}`}>
      {a.th && <img src={a.th} alt="" class="thumb" />}
      <span class="circle-play">
        <Icon name={busy ? 'clock' : 'play'} />
      </span>
      <span class="clip-meta">
        {fmtDuration(a.d ?? 0)} · {fmtSize(a.s)}
      </span>
    </button>
  );
}

export function FileChip(props: { a: Attachment }) {
  const { a } = props;
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const link = document.createElement('a');
      link.href = await mediaUrl(a);
      link.download = (a.n ?? 'file').replace(/[\\/:*?"<>|]/g, '_');
      link.click();
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" class="file-chip" onClick={download} disabled={busy} aria-label={`${t('chat.download')}: ${a.n ?? ''}`}>
      <span class="file-icon">
        <Icon name={busy ? 'clock' : 'file'} />
      </span>
      <span class="file-text">
        <b>{a.n ?? t('att.file')}</b>
        <small>{fmtSize(a.s)}</small>
      </span>
    </button>
  );
}

// CircleRecorder: camera preview first, then record up to 60 s. Reaching
// the limit sends, like Telegram.
export function CircleRecorder(props: { onSend: (o: Outgoing) => void; onClose: () => void }) {
  const preview = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [rec, setRec] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const closing = useRef(false);

  useEffect(() => {
    let s: MediaStream | null = null;
    openStream('video', facing).then(
      (st) => {
        s = st;
        setStream(st);
        void refreshDevices(); // a second camera shows up only after the permission
        if (preview.current) preview.current.srcObject = st;
      },
      (e) => {
        showToast(e?.name === 'NotAllowedError' || e?.name === 'NotFoundError' ? t('rec.noCamera') : t('rec.failed'));
        props.onClose();
      },
    );
    return () => {
      if (!rec) s?.getTracks().forEach((tr) => tr.stop());
    };
  }, [facing]);

  useEffect(() => {
    if (!rec) return;
    const timer = setInterval(() => {
      const ms = rec.elapsed();
      setElapsed(ms);
      if (ms >= VIDEO_MAX_MS || !rec.alive()) send();
    }, 100);
    return () => clearInterval(timer);
  }, [rec]);

  const cancel = () => {
    closing.current = true;
    rec?.cancel();
    stream?.getTracks().forEach((tr) => tr.stop());
    props.onClose();
  };

  async function send() {
    if (!rec || closing.current) return;
    closing.current = true;
    const v = preview.current;
    let th = '';
    let w = 480;
    let h = 480;
    if (v && v.videoWidth) {
      w = v.videoWidth;
      h = v.videoHeight;
      const c = document.createElement('canvas');
      const s = 24 / Math.max(w, h);
      c.width = Math.round(w * s);
      c.height = Math.round(h * s);
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      th = c.toDataURL('image/jpeg', 0.6);
    }
    try {
      const r = await rec.stop();
      props.onSend({ kind: 'video', blob: r.blob, mime: r.mime, d: r.d, w, h, th });
    } catch {
      showToast(t('rec.failed'));
    }
    props.onClose();
  }

  const R = 48;
  const C = 2 * Math.PI * R;
  return (
    <Modal label={t('att.circle')} onClose={cancel} class="circle-recorder">
      <div class={'circle-preview' + (facing === 'user' ? ' mirror' : '')}>
        <video ref={preview} autoPlay muted playsInline />
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r={R} stroke-dasharray={C} stroke-dashoffset={C * (1 - elapsed / VIDEO_MAX_MS)} />
        </svg>
      </div>
      <p class="rec-time" aria-live="off">
        {rec && <span class="rec-dot" />} {fmtDuration(elapsed)} / {fmtDuration(VIDEO_MAX_MS)}
      </p>
      <div class="circle-actions">
        <IconButton icon="trash" label={t('rec.cancel')} onClick={cancel} />
        {rec ? (
          <button type="button" class="send-btn big" onClick={send} aria-label={t('rec.stopSend')}>
            <Icon name="send" />
          </button>
        ) : (
          <button
            type="button"
            class="rec-btn"
            disabled={!stream}
            onClick={() => {
              if (!stream) return;
              try {
                setRec(startRecording(stream, 'video'));
              } catch {
                showToast(t('rec.failed'));
              }
            }}
            aria-label={t('rec.start')}
          >
            <span />
          </button>
        )}
        {cameras().length > 1 ? (
          <IconButton
            icon="flip"
            label={t('rec.switch')}
            disabled={!!rec}
            onClick={() => {
              stream?.getTracks().forEach((tr) => tr.stop());
              setStream(null);
              setFacing(facing === 'user' ? 'environment' : 'user');
            }}
          />
        ) : (
          <span class="btn-spacer" aria-hidden="true" /> // keeps the record button centred
        )}
      </div>
    </Modal>
  );
}

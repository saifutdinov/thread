import { canSetVolume } from '../lib/devices';
import { t } from '../lib/i18n';

// Local playback only; never changes a sender or the volume of their microphone.
export function StreamVolume(props: { label: string; value: number; onChange: (volume: number) => void }) {
  if (!canSetVolume) return <p class="muted small">{t('call.hardwareVolume')}</p>;
  const percent = `${Math.round(props.value * 100)}%`;
  return <label class="participant-volume stream-volume">
    <span>{props.label} <output>{percent}</output></span>
    <input type="range" min="0" max="1" step="0.05" value={props.value} aria-label={props.label} aria-valuetext={percent} onInput={(e) => props.onChange(Number(e.currentTarget.value))} />
    <small class="muted">{t('call.volumeLocal')}</small>
  </label>;
}

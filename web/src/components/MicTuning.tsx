import { useEffect } from 'preact/hooks';
import { t } from '../lib/i18n';
import { GATE_MAX, GATE_OFF, micDenoise, micGate, micLevel, setDenoise, setGate, watchLevel } from '../lib/mic';

// MicTuning: noise suppression and the voice gate's threshold, for a call
// on this device (mic.ts). The meter shows the level the gate hears; it
// fills green while the voice passes. reopen applies what needs the
// microphone opened again.
export function MicTuning(props: { reopen: () => Promise<void> }) {
  useEffect(() => watchLevel(), []);
  const gate = micGate.value;
  const off = gate <= GATE_OFF;
  const level = Math.min(1, Math.max(0, (micLevel.value - GATE_OFF) / (GATE_MAX - GATE_OFF)));
  const value = off ? t('mic.gateOff') : t('mic.db', { n: gate });
  const passes = !off && micLevel.value > gate;
  return (
    <fieldset class="mic-tuning">
      <legend>{t('mic.processing')}</legend>
      <label class="row">
        <input
          type="checkbox"
          checked={micDenoise.value}
          onChange={(e) => {
            setDenoise(e.currentTarget.checked);
            void props.reopen();
          }}
        />
        <span>{t('mic.denoise')}</span>
      </label>
      <label class="mic-gate">
        <span>
          {t('mic.gate')}: <b>{value}</b>
          {!off && <small class="muted"> · {passes ? t('mic.passes') : t('mic.held')}</small>}
        </span>
        <span class="mic-meter" aria-hidden="true">
          <span class={passes ? 'open' : undefined} style={{ width: `${level * 100}%` }} />
        </span>
        <input
          type="range"
          min={GATE_OFF}
          max={GATE_MAX}
          step="1"
          value={gate}
          aria-valuetext={value}
          onInput={(e) => void setGate(Number(e.currentTarget.value))}
          onChange={(e) => {
            // On release: a slider drag opens the microphone once, not at every step.
            if (setGate(Number(e.currentTarget.value))) void props.reopen();
          }}
        />
      </label>
      <p class="muted small">{t('mic.gateHint')}</p>
    </fieldset>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { errText, t } from '../lib/i18n';
import { showToast } from '../lib/store';
import { GATE_MAX, GATE_OFF, micSettings, micFailure, micLevel, setMicSettings, watchLevel } from '../lib/mic';
import type { MicModel, MicSettings } from '../lib/mic-settings';

// MicTuning: noise suppression and the voice gate's threshold, for a call
// on this device (mic.ts). The meter shows the level the gate hears; it
// fills green while the voice passes. reopen applies what needs the
// microphone opened again.
export function MicTuning(props: { reopen: () => Promise<void>; disabled?: boolean }) {
  useEffect(() => watchLevel(), []);
  const [pending, setPending] = useState(false);
  const settings = micSettings.value;
  const gate = settings.gate;
  const patch = (next: Partial<MicSettings>) => {
    if (!setMicSettings(next)) return;
    setPending(true);
    void props.reopen().catch((e) => showToast(errText(e))).finally(() => setPending(false));
  };
  const off = gate <= GATE_OFF;
  const level = Math.min(1, Math.max(0, (micLevel.value - GATE_OFF) / (GATE_MAX - GATE_OFF)));
  const value = off ? t('mic.gateOff') : t('mic.db', { n: gate });
  const passes = !off && micLevel.value > gate;
  return (
    <fieldset class="mic-tuning" disabled={props.disabled || pending}>
      <legend>{t('mic.processing')}</legend>
      {(props.disabled || pending) && <p class="muted small" role="status">{t('mic.preparing')}</p>}
      <label class="field">
        <span>{t('mic.denoise')}</span>
        <select aria-label={t('mic.denoise')} value={settings.model} onChange={(e) => patch({ model: e.currentTarget.value as MicModel })}>
          <option value="rnnoise">RNNoise</option>
          <option value="deepfilter">DeepFilterNet3</option>
          <option value="browser">{t('mic.browser')}</option>
          <option value="off">{t('mic.off')}</option>
        </select>
      </label>
      <p class="muted small">{t(settings.model === 'deepfilter' ? 'mic.deepfilterHint' : settings.model === 'rnnoise' ? 'mic.rnnoiseHint' : 'mic.browserHint')}</p>
      {micFailure.value && <p class="small" role="alert">{t('mic.failureHint')}</p>}
      {(settings.model === 'rnnoise' || settings.model === 'deepfilter') && <label class="mic-gate">
        <span>{t('mic.strength')}: <b>{Math.round(settings.strength * 100)}%</b></span>
        <input type="range" min="0" max="1" step="0.01" value={settings.strength} onInput={(e) => patch({ strength: Number(e.currentTarget.value) })} />
      </label>}
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
          onInput={(e) => patch({ gate: Number(e.currentTarget.value) })}
        />
      </label>
      <p class="muted small">{t('mic.gateHint')}</p>
      <details>
        <summary>{t('mic.advanced')}</summary>
        <label class="mic-gate"><span>{t('mic.gain')}: <b>{settings.gain} {t('mic.decibels')}</b></span><input type="range" min="-12" max="12" step="1" value={settings.gain} onInput={(e) => patch({ gain: Number(e.currentTarget.value) })} /></label>
        <label class="mic-gate"><span>{t('mic.hold')}: <b>{settings.hold} {t('mic.ms')}</b></span><input type="range" min="0" max="1000" step="50" value={settings.hold} onInput={(e) => patch({ hold: Number(e.currentTarget.value) })} /></label>
        {(['highPass', 'agc', 'echo'] as const).map((key) => <label class="row" key={key}><input type="checkbox" checked={settings[key]} onChange={(e) => patch({ [key]: e.currentTarget.checked })} /><span>{t(`mic.${key}`)}</span></label>)}
      </details>
    </fieldset>
  );
}

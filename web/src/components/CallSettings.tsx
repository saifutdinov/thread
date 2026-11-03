import type { ComponentChildren } from 'preact';
import { errText, t } from '../lib/i18n';
import { showToast } from '../lib/store';
import { Modal, Switch } from './ui';
import { setTalkMode, talkMode } from './PushToTalk';
import { cameras, deviceName, microphones, speakers } from '../lib/devices';
import { speaker } from '../lib/call';
import { canTune } from '../lib/mic';
import { MicTuning } from './MicTuning';

// CallSettings: which camera, microphone and speakers a call uses, all
// listed even when there is one (to see which), and the microphone's
// processing. On Android the "microphones" include the earpiece and the
// speakerphone. 1:1 and group calls pass their own ways to switch.
export function CallSettings(props: {
  onClose: () => void;
  diagnostics: () => Promise<void>;
  children?: ComponentChildren;
  mic?: string; // the device ids in use
  cam?: string;
  onMic: (id: string) => unknown;
  onCam: (id: string) => unknown;
  onSpeaker: (id: string) => unknown;
  reopen: () => Promise<void>; // the microphone again, with the processing as now chosen
}) {
  const cams = cameras();
  const ins = microphones();
  const outs = speakers();
  return (
    <Modal label={t('call.settings')} onClose={props.onClose} class="device-picker">
      <h2>{t('call.settings')}</h2>
      {cams.length > 0 && (
        <fieldset>
          <legend>{t('call.audio.camera')}</legend>
          {cams.map((d, i) => (
            <label key={d.deviceId} class="row">
              <input type="radio" name="cam" checked={d.deviceId === props.cam} onChange={() => void props.onCam(d.deviceId)} />
              <span>{deviceName(d, i)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {ins.length > 0 && (
        <fieldset>
          <legend>{t('call.audio.mic')}</legend>
          {ins.map((d, i) => (
            <label key={d.deviceId} class="row">
              <input type="radio" name="mic" checked={d.deviceId === props.mic} onChange={() => void props.onMic(d.deviceId)} />
              <span>{deviceName(d, i)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {canTune && <MicTuning reopen={props.reopen} />}
      {outs.length > 0 && (
        <fieldset>
          <legend>{t('call.audio.out')}</legend>
          {outs.map((d, i) => (
            <label key={d.deviceId} class="row">
              <input
                type="radio"
                name="speaker"
                checked={d.deviceId === (speaker.value || 'default')}
                onChange={() => void props.onSpeaker(d.deviceId)}
              />
              <span>{deviceName(d, i)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {props.children}
      <Switch label={t('call.pushToTalk')} hint={t('call.pushToTalkHint')} checked={talkMode.value} onChange={setTalkMode} />
      <button type="button" class="btn secondary" onClick={() => void props.diagnostics().catch((e) => showToast(errText(e)))}>{t('call.diagnostics')}</button>
      <p class="muted small">{t('call.diagnosticsHint')}</p>
      <button type="button" class="btn secondary" onClick={props.onClose}>
        {t('common.done')}
      </button>
    </Modal>
  );
}

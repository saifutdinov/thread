import { cameras, deviceName, microphones, speakers } from '../lib/devices';
import { speaker } from '../lib/call';
import { t } from '../lib/i18n';
import { canTune } from '../lib/mic';
import { MicTuning } from './MicTuning';
import { Modal } from './ui';

// CallSettings: which camera, microphone and speakers a call uses, all
// listed even when there is one (to see which), and the microphone's
// processing. On Android the "microphones" include the earpiece and the
// speakerphone. 1:1 and group calls pass their own ways to switch.
export function CallSettings(props: {
  onClose: () => void;
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
      <button type="button" class="btn secondary" onClick={props.onClose}>
        {t('common.done')}
      </button>
    </Modal>
  );
}

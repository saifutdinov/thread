import { useEffect, useState } from 'preact/hooks';
import { talkMode, setTalkMode, talkHold } from './PushToTalk';
import { talkHotkey, setTalkHotkey, globalTalk, setGlobalTalk, talkCapture, companion, probeCompanion } from '../lib/ptt-prefs';
import { DEFAULT_HOTKEY, hotkeyFromEvent, hotkeyLabel } from '../lib/hotkey';
import { t } from '../lib/i18n';
import { Modal, Switch } from './ui';

export function PushToTalkSettings() {
  const recording = talkCapture.value;
  const [help, setHelp] = useState(false);
  useEffect(() => {
    probeCompanion();
    return () => {
      talkCapture.value = false;
    };
  }, []);
  const windows = /Windows/.test(navigator.userAgent);
  const apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
  return (
    <>
      <Switch
        label={t('call.pushToTalk')}
        hint={t('call.pushToTalkHint')}
        checked={talkMode.value}
        onChange={(v) => {
          talkHold.current?.reset();
          setTalkMode(v);
        }}
      />
      <label class="field">
        <span>{t('call.talkHotkey')}</span>
        <button
          type="button"
          class="btn secondary"
          aria-label={`${t('call.talkHotkey')}: ${recording ? t('call.talkRecord') : hotkeyLabel(talkHotkey.value, apple)}`}
          aria-pressed={recording}
          onClick={() => {
            talkHold.current?.reset();
            talkCapture.value = !recording;
          }}
          onBlur={() => {
            talkCapture.value = false;
          }}
          onKeyDown={(e) => {
            if (!talkCapture.value) return;
            if (e.code === 'Tab') {
              talkCapture.value = false;
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape') {
              talkCapture.value = false;
              return;
            }
            if (e.repeat || e.isComposing || e.getModifierState('AltGraph')) return;
            const b = hotkeyFromEvent(e);
            if (b) {
              setTalkHotkey(b);
              talkCapture.value = false;
            }
          }}
        >
          {recording ? t('call.talkRecord') : hotkeyLabel(talkHotkey.value, apple)}
        </button>
      </label>
      <button
        type="button"
        class="link-btn"
        onClick={() => {
          talkHold.current?.reset();
          setTalkHotkey(DEFAULT_HOTKEY);
        }}
      >
        {t('call.talkReset')}
      </button>
      {windows ? (
        <Switch
          label={t('call.globalTalk')}
          hint={t('call.globalTalkHint')}
          checked={globalTalk.value}
          onChange={(v) => {
            talkHold.current?.reset();
            setGlobalTalk(v);
          }}
        />
      ) : (
        <p class="muted small">{t('call.globalTalkPlatform')}</p>
      )}
      {windows && globalTalk.value && (
        <>
          <button type="button" class="btn secondary" onClick={() => setHelp(true)}>
            {t('call.companionSetup')}
          </button>
          <p class="muted small" role="status">
            {t(`call.companion.${companion.value}`)}
          </p>
          <button
            type="button"
            class="btn secondary"
            onClick={() => {
              probeCompanion();
              window.dispatchEvent(new Event('thread-ptt-retry'));
            }}
          >
            {t('call.companionRetry')}
          </button>
        </>
      )}
      {help && (
        <Modal label={t('call.companionSetup')} onClose={() => setHelp(false)}>
          <h2>{t('call.companionSetup')}</h2>
          <p>{t('call.companionHelpIntro')}</p>
          <ol>
            <li>{t('call.companionHelpExtension')}</li>
            <li>{t('call.companionHelpInstall')}</li>
            <li>{t('call.companionHelpEnable')}</li>
          </ol>
          <p>{t('call.companionHelpRemove')}</p>
          <button type="button" class="btn secondary" onClick={() => setHelp(false)}>
            {t('common.done')}
          </button>
        </Modal>
      )}
    </>
  );
}

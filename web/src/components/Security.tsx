import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import type { Code } from '../lib/crypto';
import { errText, t } from '../lib/i18n';
import {
  biometricsAvailable,
  disableLock,
  enableBiometrics,
  enableLock,
  lockConf,
  unlockBiometric,
  unlockPin,
  updateLock,
  waitMs,
} from '../lib/lock';
import { logout, markVerified, me, safetyFor, showToast, type Trust } from '../lib/store';
import { copyText, Icon, Modal, Segmented, Switch } from './ui';

export function LockScreen() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const conf = lockConf.value;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!pin) return;
    if (!(await unlockPin(pin))) {
      const wait = waitMs();
      setError(wait ? t('lock.wait', { s: Math.ceil(wait / 1000) }) : t('lock.wrong'));
      setPin('');
    }
  };

  return (
    <main class="auth" aria-label={t('lock.title')}>
      <div class="auth-card">
        <img src="/icon.svg" alt="" class="auth-logo" width="72" height="72" />
        <h1>{t('lock.title')}</h1>
        <form class="stack" onSubmit={submit}>
          <label class="field">
            <span>{t('lock.enterPin')}</span>
            <input
              type="password"
              inputMode="numeric"
              autocomplete="off"
              maxLength={8}
              value={pin}
              onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
              aria-invalid={!!error}
              autoFocus
            />
          </label>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button class="btn" disabled={!pin}>
            {t('lock.unlock')}
          </button>
          {conf?.cred && (
            <button type="button" class="btn secondary" onClick={() => unlockBiometric()}>
              {t('lock.useBio')}
            </button>
          )}
          <button
            type="button"
            class="link-btn"
            onClick={() => confirm(t('settings.logoutConfirm')) && logout()}
          >
            {t('lock.forgot')}
          </button>
        </form>
      </div>
    </main>
  );
}

function PinSetup(props: { onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 8);
  const save = async (e: Event) => {
    e.preventDefault();
    if (pin.length < 4) return setError(t('lock.pin'));
    if (pin !== again) return setError(t('lock.mismatch'));
    await enableLock(pin);
    props.onClose();
  };
  return (
    <Modal label={t('lock.setTitle')} onClose={props.onClose}>
      <h2>{t('lock.setTitle')}</h2>
      <form class="stack" onSubmit={save}>
        <label class="field">
          <span>{t('lock.pin')}</span>
          <input type="password" inputMode="numeric" autocomplete="new-password" value={pin} onInput={(e) => setPin(digits(e.currentTarget.value))} autoFocus />
        </label>
        <label class="field">
          <span>{t('lock.repeat')}</span>
          <input type="password" inputMode="numeric" autocomplete="new-password" value={again} onInput={(e) => setAgain(digits(e.currentTarget.value))} />
        </label>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button class="btn">{t('lock.save')}</button>
        <button type="button" class="btn secondary" onClick={props.onClose}>
          {t('common.cancel')}
        </button>
      </form>
    </Modal>
  );
}

function PasswordChange(props: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setNext((await api.changePassword(current)).password);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal label={t('pw.change')} onClose={() => (!next || saved) && props.onClose()}>
      <h2>{next ? t('pw.title') : t('pw.change')}</h2>
      {next ? (
        <div class="stack">
          <input class="password-box" value={next} readOnly aria-label={t('pw.title')} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" class="btn secondary" onClick={async () => setCopied(await copyText(next))}>
            <Icon name="copy" /> {copied ? t('common.copied') : t('common.copy')}
          </button>
          <p>{t('pw.done')}</p>
          <label class="check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} />
            <span>{t('password.saved')}</span>
          </label>
          <button class="btn" disabled={!saved} onClick={props.onClose}>
            {t('common.done')}
          </button>
        </div>
      ) : (
        <form class="stack" onSubmit={submit}>
          <label class="field">
            <span>{t('pw.current')}</span>
            <input type="password" autocomplete="current-password" autocapitalize="none" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} autoFocus />
          </label>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button class="btn" disabled={busy || !current.trim()}>
            {t('pw.next')}
          </button>
          <button type="button" class="btn secondary" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
        </form>
      )}
    </Modal>
  );
}

export function SecuritySettings() {
  const conf = lockConf.value;
  const [setup, setSetup] = useState(false);
  const [pw, setPw] = useState(false);
  const [bio, setBio] = useState(false);
  useEffect(() => {
    biometricsAvailable().then(setBio);
  }, []);
  return (
    <section class="card stack">
      <h3>{t('sec.title')}</h3>
      <Switch label={t('lock.enable')} hint={t('lock.hint')} checked={!!conf} onChange={(v) => (v ? setSetup(true) : disableLock())} />
      {conf && (
        <>
          <span class="label">{t('lock.after')}</span>
          <Segmented
            label={t('lock.after')}
            value={conf.timeout}
            options={[
              [0, t('lock.now')],
              [60e3, t('lock.min1')],
              [300e3, t('lock.min5')],
              [3600e3, t('lock.hour')],
            ]}
            onChange={(v) => updateLock({ timeout: v })}
          />
          {bio && (
            <Switch
              label={t('lock.bio')}
              checked={!!conf.cred}
              onChange={async (v) => {
                try {
                  if (v) await enableBiometrics(me.value?.user.name ?? t('app.name'));
                  else await updateLock({ cred: undefined });
                } catch {
                  showToast(t('lock.bioFailed'));
                }
              }}
            />
          )}
          <Switch label={t('lock.hide')} hint={t('lock.hideHint')} checked={conf.hide} onChange={(v) => updateLock({ hide: v })} />
        </>
      )}
      <button class="btn secondary" onClick={() => setPw(true)}>
        {t('pw.change')}
      </button>
      {setup && <PinSetup onClose={() => setSetup(false)} />}
      {pw && <PasswordChange onClose={() => setPw(false)} />}
    </section>
  );
}

export function SafetyPanel(props: { chatId: number; userId: number; name: string }) {
  const [s, setS] = useState<{ code: Code; fp: string; trust: Trust } | null>(null);
  const load = () => safetyFor(props.chatId, props.userId).then(setS, (e) => showToast(errText(e)));
  useEffect(() => {
    load();
  }, [props.chatId, props.userId]);
  if (!s) return <p class="muted">…</p>;
  return (
    <div class="stack safety">
      <div class="device-code">
        <div class="code-emoji" aria-hidden="true">
          {s.code.emoji.join(' ')}
        </div>
        <div class="code-digits">{s.code.digits}</div>
      </div>
      <p class="muted small">{t('safety.hint', { name: props.name })}</p>
      {s.trust === 'changed' && (
        <p class="error" role="alert">
          {t('safety.changed', { name: props.name })}
        </p>
      )}
      {s.trust === 'ok' ? (
        <div class="row">
          <Icon name="check" /> <span class="row-text">{t('safety.verified')}</span>
          <button class="btn small secondary" onClick={() => markVerified(props.userId, null).then(load)}>
            {t('safety.unmark')}
          </button>
        </div>
      ) : (
        <button class="btn secondary" onClick={() => markVerified(props.userId, s.fp).then(load)}>
          <Icon name="check" /> {t('safety.mark')}
        </button>
      )}
    </div>
  );
}

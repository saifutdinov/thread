import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import { errText, lang, t } from '../lib/i18n';
import { theme } from '../lib/prefs';
import { isIOS, standalone } from '../lib/pwa';
import { replace, route } from '../lib/route';
import {
  askRecovery,
  goChat,
  joinInvite,
  login,
  logout,
  me,
  myDeviceCode,
  newPassword,
  type Peeked,
  peekInvite,
  resetDevice,
  screen,
  start,
} from '../lib/store';
import { copyText, Icon } from './ui';

function Card(props: { children: ComponentChildren }) {
  return (
    <main class="auth">
      <div class="auth-card">
        <img src="/icon.svg" alt="" class="auth-logo" width="88" height="88" />
        {props.children}
      </div>
      <div class="auth-prefs">
        <button type="button" class="link-btn" onClick={() => (lang.value = lang.value === 'ru' ? 'en' : 'ru')}>
          {lang.value === 'ru' ? 'English' : 'Русский'}
        </button>
        <button
          type="button"
          class="link-btn"
          onClick={() => (theme.value = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}
        >
          {document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </main>
  );
}

export function LoginForm(props: { onDone?: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mismatch, setMismatch] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(password);
      props.onDone?.();
    } catch (err) {
      setMismatch(err instanceof ApiError && err.code === 'device_mismatch');
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} class="stack">
      {/* Lets password managers save and fill the credential. */}
      <input type="text" name="username" autocomplete="username" value="thread" class="sr-only" tabIndex={-1} aria-hidden="true" readOnly />
      <label class="field">
        <span>{t('login.password')}</span>
        <input
          type="password"
          name="password"
          autocomplete="current-password"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          value={password}
          onInput={(e) => setPassword(e.currentTarget.value)}
          aria-invalid={!!error}
          aria-describedby={error ? 'login-error' : undefined}
          autoFocus
        />
      </label>
      {error && (
        <p id="login-error" class="error" role="alert">
          {error}
        </p>
      )}
      {mismatch && (
        <button
          type="button"
          class="btn secondary"
          onClick={async () => {
            await resetDevice();
            setMismatch(false);
            setError('');
          }}
        >
          {t('login.reset')}
        </button>
      )}
      <button class="btn" disabled={busy || !password.trim()}>
        {t('login.submit')}
      </button>
    </form>
  );
}

// PasteInvite lets an installed app (which has no URL bar) open an invite.
function PasteInvite() {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const open = (e: Event) => {
    e.preventDefault();
    const m = value.match(/#\/i\/([A-Za-z0-9_-]{20,})/);
    if (!m) return setError(true);
    replace(`i/${m[1]}`);
    screen.value = 'invite';
  };
  return (
    <details class="paste-invite">
      <summary>{t('login.haveInvite')}</summary>
      <form class="stack" onSubmit={open}>
        <input
          class="link-box"
          value={value}
          placeholder={t('login.pasteInvite')}
          aria-label={t('login.pasteInvite')}
          autocapitalize="none"
          autocorrect="off"
          onInput={(e) => {
            setValue(e.currentTarget.value);
            setError(false);
          }}
        />
        {error && (
          <p class="error" role="alert">
            {t('login.badInvite')}
          </p>
        )}
        <button class="btn secondary" disabled={!value.trim()}>
          {t('login.openInvite')}
        </button>
      </form>
    </details>
  );
}

export function LoginScreen() {
  return (
    <Card>
      <h1>{t('app.name')}</h1>
      <p class="muted">{t('login.lead')}</p>
      <LoginForm />
      <PasteInvite />
      <p class="muted small">{t('login.hint')}</p>
    </Card>
  );
}

// IOSInstallFirst: an installed iOS web app has its own storage, separate
// from Safari's. Registering in Safari and installing later would leave the
// app without keys, so on iOS the invite is carried over by copy-paste.
function IOSInstallFirst(props: { onContinue: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="stack notice-block">
      <h2>{t('ios.title')}</h2>
      <p>{t('ios.text')}</p>
      <ol class="steps">
        <li>{t('ios.step1')}</li>
        <li>{t('ios.step2')}</li>
        <li>{t('ios.step3')}</li>
      </ol>
      <button class="btn" onClick={async () => setCopied(await copyText(location.href))}>
        <Icon name="copy" /> {copied ? t('common.copied') : t('ios.copy')}
      </button>
      <button class="link-btn" onClick={props.onContinue}>
        {t('ios.continue')}
      </button>
    </div>
  );
}

export function InviteScreen() {
  const secret = route.value.secret ?? '';
  const [peeked, setPeeked] = useState<Peeked | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [haveAccount, setHaveAccount] = useState(false);
  const loggedIn = !!me.value;
  const [inSafari, setInSafari] = useState(false);

  useEffect(() => {
    peekInvite(secret).then(setPeeked, (e) => setError(errText(e)));
  }, [secret, loggedIn]);

  async function join(e?: Event) {
    e?.preventDefault();
    if (!peeked || busy) return;
    setBusy(true);
    setError('');
    try {
      const chatId = await joinInvite(peeked, name);
      if (loggedIn) {
        screen.value = 'app';
        if (chatId) replace(`c/${chatId}`);
        else replace('');
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const leave = () => {
    replace('');
    screen.value = loggedIn ? 'app' : 'login';
  };

  if (error && !peeked)
    return (
      <Card>
        <h1>{t('invite.register')}</h1>
        <p class="error" role="alert">
          {error}
        </p>
        <button class="btn" onClick={leave}>
          {loggedIn ? t('common.back') : t('invite.toLogin')}
        </button>
      </Card>
    );
  if (!peeked)
    return (
      <Card>
        <p class="muted" role="status">
          {t('invite.loading')}
        </p>
      </Card>
    );

  const { info, title } = peeked;
  const heading =
    info.kind === 'direct'
      ? t('invite.direct', { name: info.inviter ?? '' })
      : info.kind === 'group'
        ? t('invite.group', { name: info.inviter ?? '' })
        : t('invite.register');

  return (
    <Card>
      <h1>{heading}</h1>
      {title && <p class="invite-title">«{title}»</p>}
      {info.kind === 'group' && info.members !== undefined && <p class="muted">{t('chat.members', { n: info.members })}</p>}
      {!loggedIn && isIOS && !standalone.value && !inSafari ? (
        <IOSInstallFirst onContinue={() => setInSafari(true)} />
      ) : loggedIn ? (
        info.member ? (
          <>
            <p class="muted">{t('invite.already')}</p>
            <button
              class="btn"
              onClick={() => {
                screen.value = 'app';
                replace('');
                goChat(info.chat_id!);
              }}
            >
              {t('invite.open')}
            </button>
          </>
        ) : (
          <div class="stack">
            {error && (
              <p class="error" role="alert">
                {error}
              </p>
            )}
            <button class="btn" disabled={busy} onClick={() => join()}>
              {t('invite.join')}
            </button>
            <button class="btn secondary" onClick={leave}>
              {t('common.cancel')}
            </button>
          </div>
        )
      ) : haveAccount ? (
        <LoginForm />
      ) : (
        <form class="stack" onSubmit={join}>
          <label class="field">
            <span>{t('invite.name')}</span>
            <input
              value={name}
              maxLength={40}
              autocomplete="nickname"
              placeholder={t('invite.namePh')}
              onInput={(e) => setName(e.currentTarget.value)}
              aria-describedby="name-hint"
              autoFocus
            />
          </label>
          <small id="name-hint" class="muted">
            {t('invite.nameHint')}
          </small>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button class="btn" disabled={busy || !name.trim()}>
            {t('invite.create')}
          </button>
          {info.kind !== 'register' && (
            <button type="button" class="link-btn" onClick={() => setHaveAccount(true)}>
              {t('invite.haveAccount')}
            </button>
          )}
        </form>
      )}
    </Card>
  );
}

export function PasswordScreen() {
  const password = newPassword.value ?? '';
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <Card>
      <h1>{t('password.title')}</h1>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!saved) return;
          newPassword.value = null;
          start();
        }}
      >
        <input type="text" name="username" autocomplete="username" value="thread" class="sr-only" tabIndex={-1} aria-hidden="true" readOnly />
        <input
          class="password-box"
          name="password"
          type="text"
          autocomplete="new-password"
          value={password}
          readOnly
          aria-label={t('password.title')}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          class="btn secondary"
          onClick={async () => setCopied(await copyText(password))}
        >
          <Icon name="copy" /> {copied ? t('common.copied') : t('common.copy')}
        </button>
        <p>{t('password.text')}</p>
        <p class="muted small">{t('password.hint')}</p>
        <label class="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} />
          <span>{t('password.saved')}</span>
        </label>
        <button class="btn" disabled={!saved}>
          {t('common.continue')}
        </button>
      </form>
    </Card>
  );
}

export function DeviceCode(props: { code: { emoji: string[]; digits: string } | null }) {
  if (!props.code) return null;
  return (
    <div class="device-code">
      <div class="code-emoji" aria-hidden="true">
        {props.code.emoji.join(' ')}
      </div>
      <div class="code-digits">
        {t('approve.code')}: {props.code.digits}
      </div>
    </div>
  );
}

export function PendingScreen() {
  const [code, setCode] = useState<{ emoji: string[]; digits: string } | null>(null);
  const [asked, setAsked] = useState(!!me.value?.device.recovery);
  const [lost, setLost] = useState(asked);

  useEffect(() => {
    myDeviceCode().then(setCode);
    // Fallback to the socket's "approved" event, e.g. behind a flaky network.
    const timer = setInterval(async () => {
      const m = await api.me().catch(() => null);
      if (m?.device.status === 'active') start();
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Card>
      <h1>{t('pending.title')}</h1>
      <p>{t('pending.text')}</p>
      <DeviceCode code={code} />
      <p class="muted" role="status">
        {t('pending.waiting')}
      </p>
      {isIOS && standalone.value && <p class="notice">{t('pending.iosHint')}</p>}
      {!lost ? (
        <button class="link-btn" onClick={() => setLost(true)}>
          {t('pending.lost')}
        </button>
      ) : asked ? (
        <p class="notice">{t('pending.asked')}</p>
      ) : (
        <div class="stack">
          <p class="muted">{t('pending.lostText')}</p>
          <button class="btn secondary" onClick={() => askRecovery().then(() => setAsked(true))}>
            {t('pending.ask')}
          </button>
        </div>
      )}
      <button class="link-btn danger" onClick={logout}>
        {t('pending.logout')}
      </button>
    </Card>
  );
}

export function LostScreen() {
  return (
    <Card>
      <h1>{t('lost.title')}</h1>
      <p>{t('lost.text')}</p>
      <button class="btn" onClick={logout}>
        {t('lost.action')}
      </button>
    </Card>
  );
}

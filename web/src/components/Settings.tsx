import { useEffect, useState } from 'preact/hooks';
import { api, type Device } from '../lib/api';
import { errText, fmtListTime, lang, t } from '../lib/i18n';
import { linkPreviews, textSize, theme } from '../lib/prefs';
import { enablePush, install, installPrompt, isIOS, notifPermission, standalone } from '../lib/pwa';
import { back } from '../lib/route';
import { chats, devicesTick, loadChats, logout, me, myPicture, pending, setMyAvatar, showToast } from '../lib/store';
import { SecuritySettings } from './Security';
import { approving, Avatar, Icon, Panel, PictureButtons, Segmented, Switch } from './ui';

export function NotificationsRow() {
  const perm = notifPermission.value;
  if (perm === 'unsupported')
    return <p class="muted">{isIOS && !standalone.value ? t('onboard.iosNotif') : t('settings.notifUnsupported')}</p>;
  if (perm === 'granted')
    return (
      <p class="row">
        <Icon name="check" /> {t('settings.notifOn')}
      </p>
    );
  if (perm === 'denied') return <p class="muted">{t('settings.notifDenied')}</p>;
  return (
    <button class="btn" onClick={() => enablePush().catch((e) => showToast(errText(e)))}>
      <Icon name="bell" /> {t('settings.notifEnable')}
    </button>
  );
}

// MicHint: Safari, not the app, decides how long a microphone permission
// lasts; say where to make it stick. Other browsers remember it per site.
const ua = navigator.userAgent;
const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg|OPR|Firefox|YaBrowser/.test(ua);
function MicHint() {
  const key = isIOS ? (standalone.value ? 'settings.micIosApp' : safari ? 'settings.micIosSafari' : '') : safari ? 'settings.micMac' : '';
  return key ? <p class="muted small">{t(key)}</p> : null;
}

export function InstallRow() {
  if (standalone.value)
    return (
      <p class="row">
        <Icon name="check" /> {t('settings.installed')}
      </p>
    );
  if (installPrompt.value)
    return (
      <button class="btn" onClick={install}>
        {t('settings.install')}
      </button>
    );
  return <p class="muted">{isIOS ? t('settings.iosInstall') : t('settings.otherInstall')}</p>;
}

// Where users of this copy can get its source code. If you run a modified
// version, point this at your own repository.
const SOURCE_URL = 'https://github.com/saifutdinov/thread';

export function Settings() {
  const user = me.value!.user;
  const [name, setName] = useState(user.name);
  const [hide, setHide] = useState(user.hide_online);
  const [devices, setDevices] = useState<Device[]>([]);

  useEffect(() => {
    api.devices().then(setDevices, () => {});
  }, [devicesTick.value]);

  async function saveName() {
    const n = name.trim();
    if (!n || n === me.value!.user.name) return;
    try {
      await api.updateMe({ name: n });
      me.value = { ...me.value!, user: { ...me.value!.user, name: n } };
      loadChats();
    } catch (e) {
      showToast(errText(e));
      setName(me.value!.user.name);
    }
  }

  async function toggleHide(v: boolean) {
    setHide(v);
    try {
      await api.updateMe({ hide_online: v });
      me.value = { ...me.value!, user: { ...me.value!.user, hide_online: v } };
    } catch (e) {
      setHide(!v);
      showToast(errText(e));
    }
  }

  return (
    <Panel title={t('settings.title')} onBack={() => back()}>
      <section class="card">
        <div class="profile-head">
          <Avatar id={user.id} name={name} size={80} src={myPicture()} />
          {chats.value.length ? (
            <PictureButtons has={!!myPicture()} onSet={setMyAvatar} />
          ) : (
            <p class="muted small">{t('avatar.noChats')}</p>
          )}
        </div>
        <label class="field">
          <span>{t('settings.name')}</span>
          <input
            value={name}
            maxLength={40}
            onInput={(e) => setName(e.currentTarget.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </label>
        <p class="muted small">{t('settings.passwordNote')}</p>
      </section>

      <section class="card stack">
        <h3>{t('settings.appearance')}</h3>
        <span class="label">{t('settings.theme')}</span>
        <Segmented
          label={t('settings.theme')}
          value={theme.value}
          options={[
            ['system', t('settings.themeSystem')],
            ['light', t('settings.themeLight')],
            ['dark', t('settings.themeDark')],
          ]}
          onChange={(v) => (theme.value = v)}
        />
        <span class="label">{t('settings.lang')}</span>
        <Segmented
          label={t('settings.lang')}
          value={lang.value}
          options={[
            ['ru', 'Русский'],
            ['en', 'English'],
          ]}
          onChange={(v) => (lang.value = v)}
        />
        <span class="label">{t('settings.textSize')}</span>
        <Segmented
          label={t('settings.textSize')}
          value={textSize.value}
          options={[
            [90, 'A−'],
            [100, 'A'],
            [115, 'A+'],
            [130, 'A++'],
          ]}
          onChange={(v) => (textSize.value = v)}
        />
      </section>

      <section class="card">
        <h3>{t('settings.privacy')}</h3>
        <Switch label={t('settings.hideOnline')} hint={t('settings.hideOnlineHint')} checked={hide} onChange={toggleHide} />
        <Switch
          label={t('settings.linkPreviews')}
          hint={t('settings.linkPreviewsHint')}
          checked={linkPreviews.value}
          onChange={(v) => (linkPreviews.value = v)}
        />
      </section>

      <SecuritySettings />

      <section class="card stack">
        <h3>{t('settings.notifications')}</h3>
        <NotificationsRow />
      </section>

      <section class="card stack">
        <h3>{t('settings.app')}</h3>
        <InstallRow />
        <MicHint />
      </section>

      <section class="card">
        <h3>{t('settings.devices')}</h3>
        <ul class="rows">
          {devices.map((d) => {
            const p = pending.value.find((x) => x.id === d.id);
            return (
              <li class="row" key={d.id}>
                <Icon name="devices" />
                <span class="row-text">
                  <span>
                    {d.label} {d.current && <small class="muted">({t('settings.thisDevice')})</small>}
                  </span>
                  <small class={d.online ? 'accent' : 'muted'}>
                    {d.status === 'pending'
                      ? t('settings.pending')
                      : d.online
                        ? t('settings.online')
                        : t('settings.lastActive', { when: fmtListTime(d.last_seen || d.created_at) })}
                  </small>
                </span>
                {p ? (
                  <button class="btn small" onClick={() => (approving.value = p)}>
                    {t('chat.check')}
                  </button>
                ) : (
                  !d.current && (
                    <button
                      class="btn small secondary"
                      onClick={async () => {
                        if (!confirm(t('settings.revokeConfirm'))) return;
                        await api.revoke(d.id).catch((e) => showToast(errText(e)));
                        devicesTick.value++;
                      }}
                    >
                      {t('settings.revoke')}
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section class="card">
        <button class="row action danger" onClick={() => confirm(t('settings.logoutConfirm')) && logout()}>
          <Icon name="logout" /> {t('settings.logout')}
        </button>
      </section>

      {/* AGPL-3.0 section 13: users of a running copy can get its code. */}
      <p class="muted small center">
        {t('app.name')} · AGPL-3.0 ·{' '}
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {t('settings.source')}
        </a>
      </p>
    </Panel>
  );
}

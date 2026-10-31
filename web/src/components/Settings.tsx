import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Device } from '../lib/api';
import { errText, fmtListTime, lang, t } from '../lib/i18n';
import { design, linkPreviews, textSize, theme, WALLPAPERS, wallpaper } from '../lib/prefs';
import { appVersion, enablePush, install, installPrompt, isIOS, notifPermission, standalone } from '../lib/pwa';
import { back } from '../lib/route';
import { choices, choose, MAX_SOUND_FILE, ownSoundName, playSound, setOwnSound, type SoundKind } from '../lib/sounds';
import { TUNES } from '../lib/tunes';
import { hasWallPhoto, setWallPhoto } from '../lib/wallpaper';
import { chats, devicesTick, loadChats, logout, me, myPicture, pending, setMyAvatar, showToast } from '../lib/store';
import { SecuritySettings } from './Security';
import { approving, Avatar, Icon, IconButton, Panel, PictureButtons, Segmented, Switch } from './ui';

// WallpaperPicker: the chat background on this device: the theme's own,
// a drawn one, or a photo. Each tile shows its own background.
function WallpaperPicker() {
  const input = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState(false);
  useEffect(() => {
    void hasWallPhoto().then(setPhoto);
  }, []);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      await setWallPhoto(f);
      setPhoto(true);
    } catch {
      showToast(t('wall.bad'));
    }
  };
  return (
    <>
      <div class="walls" role="radiogroup" aria-label={t('settings.wallpaper')}>
        {WALLPAPERS.filter((w) => w !== 'photo').map((w) => (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={wallpaper.value === w}
            class="wall-tile"
            data-wall={w}
            onClick={() => (wallpaper.value = w)}
          >
            <span>{t(`wall.${w}`)}</span>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={wallpaper.value === 'photo'}
          class="wall-tile"
          data-wall="photo"
          onClick={() => (photo ? (wallpaper.value = 'photo') : input.current?.click())}
        >
          <Icon name="image" />
          <span>{t('wall.photo')}</span>
        </button>
      </div>
      {photo && (
        <button type="button" class="link-btn" onClick={() => input.current?.click()}>
          {t('wall.photoPick')}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void pick(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }}
      />
    </>
  );
}

// SoundRow: which sound this device plays for one kind, a built-in tune or
// a file of the person's own, and a button to hear it.
function SoundRow(props: { kind: SoundKind }) {
  const { kind } = props;
  const id = choices.value[kind];
  const [file, setFile] = useState<string | null>(null);
  const [stop, setStop] = useState<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void ownSoundName(kind).then(setFile);
  }, [kind]);
  useEffect(() => () => stop?.(), [stop]); // leaving the page stops the preview
  const listen = () => {
    if (stop) return setStop(null);
    const end = playSound(kind);
    setStop(() => end);
    // A ring repeats: a few seconds are enough to hear it.
    setTimeout(() => setStop((s) => (s === end ? null : s)), kind === 'message' ? 1500 : 6000);
  };
  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      await setOwnSound(kind, f);
      setFile(f.name);
    } catch (e) {
      showToast(t((e as Error).message === 'too_large' ? 'sound.tooBig' : 'sound.bad', { mb: MAX_SOUND_FILE >> 20 }));
    }
  };
  return (
    <div class="sound-row">
      <label class="field">
        <span>{t(`sound.${kind}`)}</span>
        <select
          value={id}
          onChange={(e) => {
            const v = e.currentTarget.value;
            stop?.(); // the preview of the old choice ends
            setStop(null);
            if (v === 'file' && !file) {
              e.currentTarget.value = id; // stays until a file is picked
              input.current?.click();
            } else choose(kind, v);
          }}
        >
          {Object.keys(TUNES[kind]).map((k) => (
            <option key={k} value={k}>
              {t(`tune.${k}`)}
            </option>
          ))}
          <option value="file">{file ? t('sound.fileNamed', { name: file }) : t('sound.file')}</option>
        </select>
      </label>
      <IconButton icon={stop ? 'pause' : 'play'} label={stop ? t('sound.stop') : t('sound.preview')} disabled={id === 'off'} onClick={listen} />
      {/* Always here: a select's change may come without the tap a file picker needs (iOS). */}
      <IconButton icon="file" label={file ? t('sound.pickFile') : t('sound.chooseFile')} onClick={() => input.current?.click()} />
      <input
        ref={input}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          void pickFile(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}

export function NotificationsRow() {
  const perm = notifPermission.value;
  if (perm === 'unsupported')
    return <p class="muted">{isIOS && !standalone.value ? t('onboard.iosNotif') : t('settings.notifUnsupported')}</p>;
  if (perm === 'granted')
    return (
      <>
        <p class="row">
          <Icon name="check" /> {t('settings.notifOn')}
        </p>
        <button class="btn secondary" onClick={() => testPush().catch((e) => showToast(errText(e)))}>
          <Icon name="bell" /> {t('settings.notifTest')}
        </button>
      </>
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

// testPush asks the server for a notification to this device. None sent:
// the subscription got lost, so subscribe again and retry once.
async function testPush() {
  let { sent } = await api.pushTest();
  if (!sent && (await enablePush())) ({ sent } = await api.pushTest());
  showToast(t(sent ? 'settings.notifTestSent' : 'settings.notifTestNone'));
}

// NotifGuide: what to switch on where, this device's platform first.
const guides = ['ios', 'android', 'macSafari', 'desktop'];
function NotifGuide() {
  const mine = isIOS ? 'ios' : /Android/i.test(ua) ? 'android' : safari ? 'macSafari' : 'desktop';
  return (
    <details class="guide">
      <summary>{t('settings.notifHelp')}</summary>
      {[mine, ...guides.filter((g) => g !== mine)].map((g) => (
        <section key={g}>
          <h4>
            {t(`guide.${g}`)} {g === mine && <small class="muted">({t('settings.notifThis')})</small>}
          </h4>
          <ol>
            {t(`guide.${g}Steps`)
              .split('\n')
              .map((s) => (
                <li key={s}>{s}</li>
              ))}
          </ol>
        </section>
      ))}
    </details>
  );
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
        <span class="label">{t('settings.design')}</span>
        <Segmented
          label={t('settings.design')}
          value={design.value}
          options={[
            ['fresh', t('design.fresh')],
            ['classic', t('design.classic')],
          ]}
          onChange={(v) => (design.value = v)}
        />
        <span class="label">{t('settings.wallpaper')}</span>
        <WallpaperPicker />
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
        <NotifGuide />
      </section>

      <section class="card stack">
        <h3>{t('settings.sounds')}</h3>
        <SoundRow kind="ring" />
        <SoundRow kind="dial" />
        <SoundRow kind="message" />
        <p class="muted small">{t('settings.soundsHint')}</p>
      </section>

      <section class="card stack">
        <h3>{t('settings.app')}</h3>
        <InstallRow />
        <MicHint />
        {/* An installed app has no reload button of its own. */}
        <button class="btn secondary" onClick={() => location.reload()}>
          <Icon name="refresh" /> {t('settings.reload')}
        </button>
        <p class="muted small">{t('settings.version', { v: appVersion })}</p>
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

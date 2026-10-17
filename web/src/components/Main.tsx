import { useEffect, useState } from 'preact/hooks';
import { fromB64 } from '../lib/crypto';
import { deviceCode } from '../lib/crypto';
import { errText, t } from '../lib/i18n';
import { isIOS, notifPermission, pushSupported, standalone } from '../lib/pwa';
import { go, route } from '../lib/route';
import { approveDevice, denyDevice, pending, showToast, toast } from '../lib/store';
import { DeviceCode } from './Auth';
import { CallScreen } from './Call';
import { ChatInfo } from './ChatInfo';
import { ChatList } from './ChatList';
import { ChatView } from './ChatView';
import { NewChat } from './NewChat';
import { InstallRow, NotificationsRow, Settings } from './Settings';
import { approving, Icon, Lightbox, Modal } from './ui';

function ApproveDialog() {
  const p = approving.value;
  const [code, setCode] = useState<{ emoji: string[]; digits: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCode(null);
    if (p) deviceCode(fromB64(p.enc_pub), fromB64(p.sig_pub)).then(setCode);
  }, [p?.id]);
  if (!p) return null;

  const close = () => (approving.value = null);
  const run = (fn: () => Promise<void>, done?: string) => async () => {
    setBusy(true);
    try {
      await fn();
      if (done) showToast(done);
      close();
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal label={p.own ? t('approve.own') : t('approve.partner', { name: p.name })} onClose={close}>
      <h2>{p.own ? t('approve.own') : t('approve.partner', { name: p.name })}</h2>
      <p>{p.own ? t('approve.ownText', { label: p.label }) : t('approve.partnerText', { name: p.name, label: p.label })}</p>
      <DeviceCode code={code} />
      <div class="stack">
        <button class="btn" disabled={busy} onClick={run(() => approveDevice(p), t('approve.done'))}>
          {t('approve.allow')}
        </button>
        {p.own && (
          <button class="btn danger" disabled={busy} onClick={run(() => denyDevice(p))}>
            {t('approve.deny')}
          </button>
        )}
        <button class="btn secondary" onClick={close}>
          {t('common.later')}
        </button>
      </div>
    </Modal>
  );
}

// EmptyPane fills the right side when no chat is open, with what helps in
// the current section rather than a bare "pick a chat".
function EmptyPane() {
  const r = route.value.name;
  return (
    <div class="main-empty">
      {r === 'settings' ? (
        <div class="empty-card">
          <Icon name="check" />
          <b>{t('empty.settings')}</b>
          <p>{t('empty.settingsTip')}</p>
        </div>
      ) : r === 'new' ? (
        <div class="empty-card">
          <Icon name="link" />
          <b>{t('empty.newTitle')}</b>
          <p>{t('empty.newTip')}</p>
        </div>
      ) : (
        <div class="empty-card">
          <span>{t('empty.list')}</span>
          <button type="button" class="btn small" onClick={() => go('new')}>
            <Icon name="edit" /> {t('list.new')}
          </button>
        </div>
      )}
    </div>
  );
}

// Onboarding asks once per device, right after sign-in: notifications,
// then installing to the home screen (the only way to get push on iOS).
function Onboarding() {
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem('onboarded');
    } catch {
      return false;
    }
  });
  const needed = (pushSupported && notifPermission.value === 'default') || !standalone.value || (isIOS && !pushSupported);
  if (!open || !needed) return null;
  const done = () => {
    try {
      localStorage.setItem('onboarded', '1');
    } catch {
      /* shows again next time, acceptable */
    }
    setOpen(false);
  };
  return (
    <Modal label={t('onboard.title')} onClose={done}>
      <h2>{t('onboard.title')}</h2>
      {pushSupported ? (
        notifPermission.value === 'default' && (
          <div class="stack">
            <p>{t('onboard.notif')}</p>
            <NotificationsRow />
          </div>
        )
      ) : (
        isIOS && <p>{t('onboard.iosNotif')}</p>
      )}
      {!standalone.value && (
        <div class="stack">
          <p>{t('onboard.install')}</p>
          <InstallRow />
        </div>
      )}
      <button class="btn secondary" onClick={done}>
        {t('common.done')}
      </button>
    </Modal>
  );
}

export function Main() {
  const r = route.value;
  const chatId = r.name === 'chat' || r.name === 'info' ? r.id : undefined;

  // Pop the approval dialog for my own new device as soon as it shows up.
  useEffect(() => {
    const own = pending.value.find((p) => p.own);
    if (own && !approving.value) approving.value = own;
  }, [pending.value]);

  return (
    <div class={'app' + (chatId ? ' in-chat' : '') + (r.name === 'info' ? ' in-info' : '')}>
      <aside class="sidebar">
        <ChatList />
        {r.name === 'settings' && <Settings />}
        {r.name === 'new' && <NewChat />}
      </aside>
      <main class="main">
        {chatId ? <ChatView id={chatId} /> : <EmptyPane />}
      </main>
      {r.name === 'info' && chatId && <ChatInfo id={chatId} />}
      <CallScreen />
      <ApproveDialog />
      <Lightbox />
      <Onboarding />
      {toast.value && (
        <div class="toast" role="status">
          {toast.value}
        </div>
      )}
    </div>
  );
}

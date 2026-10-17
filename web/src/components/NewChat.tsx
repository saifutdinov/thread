import { useState } from 'preact/hooks';
import { errText, t } from '../lib/i18n';
import { back, replace } from '../lib/route';
import { createChat, showToast } from '../lib/store';
import { copyText, Icon, Panel, Segmented } from './ui';

// LinkView shows a fresh invite link, or any other one-time link when the
// caller passes its own wording.
export function LinkView(props: {
  link: string;
  uses: number;
  onOpen?: () => void;
  openLabel?: string;
  copy?: { title: string; text: string; note: string };
}) {
  const [copied, setCopied] = useState(false);
  const title = props.copy?.title ?? t('link.title');
  return (
    <div class="stack link-view">
      <h3>{title}</h3>
      <p class="muted">{props.copy?.text ?? (props.uses === 1 ? t('link.text') : t('link.textGroup'))}</p>
      <input class="link-box" value={props.link} readOnly aria-label={title} onFocus={(e) => e.currentTarget.select()} />
      <small class="muted">{props.copy?.note ?? (props.uses === 1 ? t('link.once') : t('link.uses', { n: props.uses }))}</small>
      <div class="row-buttons">
        <button class="btn" onClick={async () => setCopied(await copyText(props.link))}>
          <Icon name="copy" /> {copied ? t('common.copied') : t('common.copy')}
        </button>
        {'share' in navigator && (
          <button class="btn secondary" onClick={() => navigator.share({ url: props.link }).catch(() => {})}>
            <Icon name="share" /> {t('common.share')}
          </button>
        )}
      </div>
      {props.onOpen && (
        <button class="btn secondary" onClick={props.onOpen}>
          {props.openLabel ?? t('common.done')}
        </button>
      )}
    </div>
  );
}

export function NewChat() {
  const [kind, setKind] = useState<'direct' | 'group'>('direct');
  const [title, setTitle] = useState('');
  const [seats, setSeats] = useState(5);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ chatId: number; link: string } | null>(null);

  async function create(e: Event) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      setMade(await createChat(kind, kind === 'group' ? title.trim() : '', kind === 'group' ? seats : 1));
    } catch (err) {
      showToast(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={t('new.title')} onBack={() => back()}>
      {made ? (
        <section class="card">
          <LinkView
            link={made.link}
            uses={kind === 'group' ? seats : 1}
            openLabel={t('link.open')}
            onOpen={() => replace(`c/${made.chatId}`)}
          />
        </section>
      ) : (
        <form class="card stack" onSubmit={create}>
          <Segmented
            label={t('new.title')}
            value={kind}
            options={[
              ['direct', t('new.direct')],
              ['group', t('new.group')],
            ]}
            onChange={setKind}
          />
          {kind === 'group' && (
            <>
              <label class="field">
                <span>{t('new.groupTitle')}</span>
                <input value={title} maxLength={64} onInput={(e) => setTitle(e.currentTarget.value)} required />
              </label>
              <label class="field">
                <span>{t('new.seats')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={200}
                  value={seats}
                  onInput={(e) => setSeats(Math.max(1, Math.min(200, Number(e.currentTarget.value) || 1)))}
                />
              </label>
            </>
          )}
          <p class="muted small">{kind === 'group' ? t('new.groupHint') : t('new.directHint')}</p>
          <button class="btn" disabled={busy || (kind === 'group' && !title.trim())}>
            <Icon name="link" /> {t('new.create')}
          </button>
        </form>
      )}
    </Panel>
  );
}

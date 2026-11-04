import { useState } from 'preact/hooks';
import { call } from '../lib/call';
import { remember, remembered } from '../lib/devices';
import { groupCall } from '../lib/group';
import { fmtDate, lang, t } from '../lib/i18n';
import { type PatchNote, patchNotes } from '../lib/patch-notes';
import { appVersion } from '../lib/pwa';
import { Icon, Modal } from './ui';

function Lines(props: { note: PatchNote }) {
  return (
    <ul class="patch-note">
      {props.note[lang.value].map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

// PatchNotes: every release in the settings, the newest one open.
export function PatchNotes() {
  return (
    <section class="card stack patch-notes">
      <h3>{t('notes.title')}</h3>
      {patchNotes.map((note, i) => (
        <details key={note.version} open={i === 0}>
          <summary>
            {note.version}, {fmtDate(Date.parse(note.date + 'T12:00'))}
          </summary>
          <Lines note={note} />
        </details>
      ))}
    </section>
  );
}

// PatchBanner: the running release has notes this device has not seen. Once
// per release, above the chat list, and never over a call.
export function PatchBanner() {
  const note = patchNotes.find((n) => n.version === appVersion);
  const [seen, setSeen] = useState(remembered('patchNotes'));
  const [open, setOpen] = useState(false);
  if (!note || seen === note.version || call.value || groupCall.value) return null;
  const close = () => {
    remember('patchNotes', note.version);
    setSeen(note.version);
  };
  return (
    <section class="notif-banner" role="region" aria-label={t('notes.title')}>
      <Icon name="bell" />
      <p>{t('notes.banner', { v: note.version })}</p>
      <div class="row-buttons">
        <button class="btn" onClick={() => setOpen(true)}>
          {t('notes.open')}
        </button>
        <button class="btn secondary" onClick={close}>
          {t('common.close')}
        </button>
      </div>
      {open && (
        <Modal label={t('notes.title')} onClose={close}>
          <h2>{t('notes.title')}</h2>
          <p class="muted small">{note.version}</p>
          <Lines note={note} />
          <button class="btn" onClick={close}>
            {t('common.close')}
          </button>
        </Modal>
      )}
    </section>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { nativeApp, type GalleryItem } from '../lib/pwa';
import { fmtDuration } from '../lib/recorder';
import { MAX_FILE, showToast } from '../lib/store';
import { Camera } from './Camera';
import { Icon, Modal } from './ui';

// The attach sheet on phones: our camera first, then the phone's photos and
// videos (the Android app reads the gallery, Gallery.kt), else the system's
// own picker (a browser cannot list a phone's photos), and a file.
export function AttachSheet(props: { onFiles: (files: File[], asFile?: boolean) => void; onPickSystem: () => void; onPickFile: () => void; onClose: () => void }) {
  const [camera, setCamera] = useState(false);
  const [items, setItems] = useState<GalleryItem[] | null | undefined>(undefined); // undefined: loading, null: no access
  const [chosen, setChosen] = useState<GalleryItem[]>([]);
  const [adding, setAdding] = useState(false);
  const gallery = nativeApp?.gallery;

  const load = () => gallery?.().then((list) => setItems(list), () => setItems(null));
  useEffect(() => void load(), []);

  // By id and kind: a reload of the list brings new objects for the same items.
  const same = (a: GalleryItem, b: GalleryItem) => a.id === b.id && a.k === b.k;
  const toggle = (it: GalleryItem) => {
    if (it.s > MAX_FILE) return showToast(t('att.tooBig')); // never read a phone's long video into memory
    setChosen((cur) => (cur.some((x) => same(x, it)) ? cur.filter((x) => !same(x, it)) : [...cur, it]));
  };

  async function add() {
    setAdding(true);
    try {
      const files = await Promise.all(
        chosen.map(async (it) => {
          const r = await fetch(`/_gallery/file/${it.k}/${it.id}`);
          if (!r.ok) throw new Error('gallery'); // deleted meanwhile, or the access taken back
          const blob = await r.blob();
          return new File([blob], it.n || `${it.k}-${it.id}`, { type: it.m || blob.type });
        }),
      );
      props.onFiles(files);
      props.onClose();
    } catch {
      showToast(t('att.galleryFailed'));
    } finally {
      setAdding(false);
    }
  }

  if (camera)
    return (
      <Camera
        onShot={(f) => {
          props.onFiles([f]);
          props.onClose();
        }}
        onClose={() => setCamera(false)}
      />
    );

  return (
    <Modal label={t('att.menu')} onClose={props.onClose} class="sheet-modal">
      <section class="attach-sheet">
        <div class="attach-grid">
          <button type="button" class="attach-tile camera-tile" onClick={() => setCamera(true)}>
            <Icon name="videocam" />
            <span>{t('camera.title')}</span>
          </button>
          {!gallery || items === null ? (
            <button type="button" class="attach-tile" onClick={() => (props.onClose(), props.onPickSystem())}>
              <Icon name="image" />
              <span>{t('att.photos')}</span>
            </button>
          ) : (
            items?.map((it) => {
              const n = chosen.findIndex((x) => same(x, it)) + 1;
              return (
                <button
                  type="button"
                  key={it.id}
                  class={'attach-tile thumb' + (n ? ' chosen' : '')}
                  aria-pressed={!!n}
                  aria-label={`${t(it.k === 'video' ? 'att.clip' : 'att.photo')} ${it.n}`}
                  onClick={() => toggle(it)}
                >
                  <img src={`/_gallery/thumb/${it.k}/${it.id}`} alt="" loading="lazy" decoding="async" />
                  {it.k === 'video' && <span class="tile-duration">{fmtDuration(it.d)}</span>}
                  {n > 0 && <span class="tile-mark">{n}</span>}
                </button>
              );
            })
          )}
        </div>
        {gallery && items === null && (
          <p class="muted small">
            {t('att.galleryDenied')}{' '}
            <button type="button" class="linkish" onClick={() => void load()}>
              {t('att.galleryAllow')}
            </button>
          </p>
        )}
        <div class="attach-actions">
          <button type="button" class="btn secondary" onClick={() => (props.onClose(), props.onPickFile())}>
            <Icon name="file" /> {t('att.files')}
          </button>
          {gallery && items && (
            <button type="button" class="btn secondary" onClick={() => (props.onClose(), props.onPickSystem())}>
              <Icon name="image" /> {t('att.system')}
            </button>
          )}
          {chosen.length > 0 && (
            <button type="button" class="btn" disabled={adding} onClick={() => void add()}>
              {t('att.add', { n: chosen.length })}
            </button>
          )}
        </div>
      </section>
    </Modal>
  );
}

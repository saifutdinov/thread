import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { isIOS } from '../lib/pwa';
import { fmtSize } from '../lib/recorder';
import { showToast } from '../lib/store';
import { Icon } from './ui';

// The apps' installers from this server (/api/downloads, filled by each
// release): on the sign-in screen and in Settings, in a browser or in an
// app, to install here or to send the link to someone. This system's own
// comes first and is marked.
interface Installer {
  name: string;
  platform: string; // windows, mac-arm, mac-intel, linux-deb, linux-appimage, android
  size: number;
}

const OS: [string, string[]][] = [
  ['windows', ['windows']],
  ['mac', ['mac-arm', 'mac-intel']],
  ['linux', ['linux-deb', 'linux-appimage']],
  ['android', ['android']],
];

function mySystem(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (isIOS) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return '';
}

// A Mac's chip, where the browser tells (Chromium); Safari does not.
function useMacChip(): 'arm' | 'x86' | '' {
  const [chip, setChip] = useState<'arm' | 'x86' | ''>('');
  useEffect(() => {
    const ua = (navigator as { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ architecture?: string }> } }).userAgentData;
    ua?.getHighEntropyValues(['architecture'])
      .then((v) => setChip(v.architecture === 'arm' ? 'arm' : v.architecture === 'x86' ? 'x86' : ''))
      .catch(() => {});
  }, []);
  return chip;
}

async function share(url: string) {
  try {
    if (navigator.share) return await navigator.share({ title: 'Thread', url });
    await navigator.clipboard.writeText(url);
    showToast(t('apps.copied'));
  } catch {
    /* closed the share sheet */
  }
}

export function Downloads() {
  const [list, setList] = useState<Installer[]>([]);
  const chip = useMacChip();
  useEffect(() => {
    fetch('/api/downloads', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setList, () => {});
  }, []);
  const mine = mySystem();
  const groups = OS.map(([os, kinds]) => ({ os, items: kinds.flatMap((k) => list.filter((d) => d.platform === k)) }))
    .filter((g) => g.items.length)
    .sort((a, b) => Number(b.os === mine) - Number(a.os === mine));
  if (!groups.length) return null;
  const best = (d: Installer) => d.platform === (chip === 'x86' ? 'mac-intel' : 'mac-arm') || !d.platform.startsWith('mac');
  return (
    <section class="downloads stack" aria-labelledby="downloads-title">
      <h3 id="downloads-title">{t('apps.title')}</h3>
      <p class="muted small">{t('apps.lead')}</p>
      {mine === 'ios' && <p class="muted small">{t('apps.ios')}</p>}
      <ul class="rows">
        {groups.map((g) => (
          <li key={g.os} class={'download' + (g.os === mine ? ' current' : '')}>
            <span class="download-os">
              <strong>{t('apps.os.' + g.os)}</strong>
              {g.os === mine && <span class="chip on">{t('apps.yours')}</span>}
            </span>
            {g.items.map((d) => {
              const url = `${location.origin}/api/downloads/${encodeURIComponent(d.name)}`;
              return (
                <span key={d.name} class={'download-file' + (g.os === mine && best(d) ? ' best' : '')}>
                  <a class={'btn small' + (g.os === mine && best(d) ? '' : ' secondary')} href={url} target="_blank" rel="noopener">
                    <Icon name="download" /> {t('apps.kind.' + d.platform)} · {fmtSize(d.size)}
                  </a>
                  <button type="button" class="icon-btn" aria-label={t('apps.share')} title={t('apps.share')} onClick={() => void share(url)}>
                    <Icon name="share" />
                  </button>
                </span>
              );
            })}
          </li>
        ))}
      </ul>
      <p class="muted small">{t('apps.unsigned')}</p>
    </section>
  );
}

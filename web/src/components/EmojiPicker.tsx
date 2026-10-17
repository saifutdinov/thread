import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n';

interface E {
  emoji: string;
  name: string;
  emoji_version: string;
}
interface Group {
  slug: string;
  emojis: E[];
}

// Native emoji (system font), data loaded lazily as its own chunk. Emoji
// newer than 14.0 are dropped: older phones would render empty boxes.
let data: Promise<Group[]> | null = null;
const load = () =>
  (data ??= import('unicode-emoji-json/data-by-group.json').then((m) =>
    (m.default as Group[])
      .filter((g) => g.slug !== 'component')
      .map((g) => ({ slug: g.slug, emojis: g.emojis.filter((e) => parseFloat(e.emoji_version) <= 14) })),
  ));

const TAB_ICON: Record<string, string> = {
  recent: '🕘',
  smileys_emotion: '😀',
  people_body: '👋',
  animals_nature: '🐻',
  food_drink: '🍔',
  travel_places: '🚗',
  activities: '⚽',
  objects: '💡',
  symbols: '❤️',
  flags: '🏁',
};

function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem('recentEmoji') ?? '[]');
  } catch {
    return [];
  }
}

function remember(e: string) {
  try {
    localStorage.setItem('recentEmoji', JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, 24)));
  } catch {
    /* not persisted, fine */
  }
}

export function EmojiPicker(props: { onPick: (e: string) => void; onClose: () => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [tab, setTab] = useState(recent().length ? 'recent' : 'smileys_emotion');
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    load().then(setGroups);
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && props.onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    setTimeout(() => document.addEventListener('pointerdown', away));
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, []);

  const needle = q.trim().toLowerCase();
  const shown: { emoji: string; name: string }[] = needle
    ? groups.flatMap((g) => g.emojis.filter((e) => e.name.includes(needle))).slice(0, 160)
    : tab === 'recent'
      ? recent().map((emoji) => ({ emoji, name: emoji }))
      : (groups.find((g) => g.slug === tab)?.emojis ?? []);

  return (
    <div class="emoji-picker" ref={ref} role="dialog" aria-label={t('chat.emoji')}>
      <input
        type="search"
        class="search"
        placeholder={t('list.search')}
        aria-label={t('list.search')}
        value={q}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      {!needle && (
        <div class="emoji-tabs" role="tablist">
          {['recent', ...groups.map((g) => g.slug)].map((slug) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === slug}
              aria-label={slug.replace(/_/g, ' ')}
              class={tab === slug ? 'on' : ''}
              onClick={() => setTab(slug)}
            >
              {TAB_ICON[slug] ?? '•'}
            </button>
          ))}
        </div>
      )}
      <div class="emoji-grid" role="listbox">
        {shown.map((e) => (
          <button
            type="button"
            role="option"
            aria-label={e.name}
            title={e.name}
            onClick={() => {
              remember(e.emoji);
              props.onPick(e.emoji);
            }}
          >
            {e.emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

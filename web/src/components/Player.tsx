import { call, shareMusic, stopMusic } from '../lib/call';
import { groupCall, shareGroupMusic, stopGroupMusic } from '../lib/group';
import { t } from '../lib/i18n';
import { musicTrack, player, playerDur, playerPos, seekTo, step, stopPlayer, togglePlay } from '../lib/player';
import { fmtDuration } from '../lib/recorder';
import { go } from '../lib/route';
import { trackInfo } from '../lib/track';
import { IconButton } from './ui';

// PlayerBar: the track that plays, on top of the app like a minimized
// call, wherever I am. In a call it can play into the call too.
export function PlayerBar() {
  const p = player.value;
  if (!p) return null;
  const { title, artist } = trackInfo(p.t.a);
  const one = call.value?.phase === 'active';
  const group = groupCall.value?.phase === 'active';
  const sending = !!(call.value?.playerMusic || groupCall.value?.playerMusic);
  const toCall = () => {
    if (sending) return void (one ? stopMusic() : stopGroupMusic());
    const track = musicTrack();
    void (one ? shareMusic(track) : shareGroupMusic(track));
  };
  return (
    <div class="player-bar" role="region" aria-label={t('music.player')}>
      <IconButton icon="prev" label={t('music.prev')} onClick={() => void step(-1)} />
      <IconButton icon={p.playing ? 'pause' : 'play'} label={p.playing ? t('play.pause') : t('play.play')} onClick={togglePlay} />
      <IconButton icon="next" label={t('music.next')} onClick={() => void step(1)} />
      <div class="player-main">
        <button type="button" class="player-title" onClick={() => go(`c/${p.t.chat}`)} aria-label={t('music.openChat', { title: title || t('music.unknown') })}>
          <b>{title || t('music.unknown')}</b>
          {artist && <span>{artist}</span>}
        </button>
        <input
          type="range"
          class="player-seek"
          min={0}
          max={Math.max(1, Math.round(playerDur.value))}
          step={1}
          value={Math.round(playerPos.value)}
          onInput={(e) => seekTo(Number(e.currentTarget.value))}
          aria-label={t('music.seek')}
          aria-valuetext={`${fmtDuration(playerPos.value * 1000)} / ${fmtDuration(playerDur.value * 1000)}`}
        />
      </div>
      {(one || group) && (
        <IconButton
          icon="volume"
          class={sending ? 'on' : ''}
          aria-pressed={sending}
          label={sending ? t('music.callStop') : t('music.toCall')}
          onClick={toCall}
        />
      )}
      <IconButton
        icon="close"
        label={t('music.close')}
        onClick={() => {
          if (sending) void (one ? stopMusic() : stopGroupMusic());
          stopPlayer();
        }}
      />
    </div>
  );
}

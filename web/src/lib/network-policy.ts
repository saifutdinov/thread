export type NetworkMode = 'auto' | 'normal' | 'economy';
export type NetworkQuality = 'good' | 'fair' | 'poor';

// Sustained bad conditions reduce video; recovery needs a longer healthy
// period. Unknown samples and reconnects must not count as healthy time.
export class NetworkPolicy {
  private poorAt: number | null = null;
  private goodAt: number | null = null;
  private previousMode: NetworkMode = 'auto';
  private reduced = false;
  reset() { this.poorAt = this.goodAt = null; this.reduced = false; this.previousMode = 'auto'; }
  observe(mode: NetworkMode, quality?: NetworkQuality, now = performance.now()) {
    if (mode !== this.previousMode) { this.poorAt = this.goodAt = null; this.previousMode = mode; }
    if (mode !== 'auto') return this.reduced = mode === 'economy';
    if (quality === 'poor') {
      this.goodAt = null;
      this.poorAt ??= now;
      if (now - this.poorAt >= 8000) this.reduced = true;
    } else if (quality === 'good') {
      this.poorAt = null;
      this.goodAt ??= now;
      if (now - this.goodAt >= 30_000) this.reduced = false;
    } else if (quality === 'fair') {
      // A fluctuating poor/fair link is still degraded. Fair cannot start
      // reduction on its own, and cannot count towards healthy recovery.
      this.goodAt = null;
    } else {
      this.poorAt = this.goodAt = null;
    }
    return this.reduced;
  }
}

export function videoBudget(reduced: boolean, screen = false) {
  return reduced ? { maxBitrate: screen ? 800_000 : 350_000, maxFramerate: screen ? 8 : 12, scaleResolutionDownBy: screen ? 1 : 2 }
    : { maxBitrate: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 1 };
}

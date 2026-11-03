// Multiple input sources may overlap. Releasing one must not open a mic.
// Each window releases its own inputs on focus loss, even without keyup.
export class Hold {
  private sources = new Set<string | symbol>();
  private change: (held: boolean) => void;
  constructor(change: (held: boolean) => void) {
    this.change = change;
  }
  set(source: string | symbol, down: boolean) {
    const before = this.sources.size > 0;
    if (down) this.sources.add(source);
    else this.sources.delete(source);
    const after = this.sources.size > 0;
    if (before !== after) this.change(after);
  }
  reset() {
    this.sources.clear();
    this.change(false);
  }
}

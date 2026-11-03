export interface MediaLease {
  url: Promise<string>;
  release(): void;
}
interface Entry {
  refs: number;
  size: number;
  url?: string;
  promise: Promise<string>;
}

// Visible players retain their URLs. Only unused entries are evicted, so a
// memory limit cannot interrupt a video or revoke an image still on screen.
export class MediaCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private maxBytes: number;
  private maxEntries: number;
  private urls: { create(b: Blob): string; revoke(u: string): void };
  constructor(
    maxBytes = 64 * 1024 * 1024,
    maxEntries = 128,
    urls = { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) },
  ) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.urls = urls;
  }

  acquire(id: string, load: () => Promise<Blob>): MediaLease {
    let entry = this.entries.get(id);
    if (!entry) {
      const created: Entry = { refs: 0, size: 0, promise: Promise.resolve('') };
      created.promise = Promise.resolve()
        .then(load)
        .then((blob) => {
          if (this.entries.get(id) !== created) throw new Error('media released');
          created.size = blob.size;
          created.url = this.urls.create(blob);
          this.bytes += blob.size;
          this.trim();
          return created.url;
        })
        .catch((e) => {
          if (this.entries.get(id) === created) this.entries.delete(id);
          throw e;
        });
      entry = created;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    entry.refs++;
    let released = false;
    return {
      url: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        this.trim();
      },
    };
  }

  clear() {
    for (const e of this.entries.values()) if (e.url) this.urls.revoke(e.url);
    this.entries.clear();
    this.bytes = 0;
  }

  private trim() {
    for (const [id, e] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      if (e.refs || !e.url) continue;
      this.urls.revoke(e.url);
      this.bytes -= e.size;
      this.entries.delete(id);
    }
  }
}

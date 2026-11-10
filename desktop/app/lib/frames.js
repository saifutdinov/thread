// Native messaging framing, the same the browser uses with thread-hotkeys
// (internal/hotkeys): a little-endian uint32 length, then that much JSON.
const MAX = 64 << 10;

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

export class Frames {
  buf = Buffer.alloc(0);
  // push returns the whole messages so far; a frame too big or not JSON throws.
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 4) {
      const size = this.buf.readUInt32LE(0);
      if (size > MAX) throw new Error('frame too big');
      if (this.buf.length < 4 + size) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + size).toString('utf8')));
      this.buf = this.buf.subarray(4 + size);
    }
    return out;
  }
}

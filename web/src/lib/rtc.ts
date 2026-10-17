// Call quality tuning that does not touch the DOM, so node:test covers it.

// tuneOpus asks the other side for better Opus than the browser default
// (~32 kbit/s): in-band FEC against packet loss, no DTX (it clips the start
// of words), up to 48 kbit/s mono (transparent for speech; with RED redundancy
// that is ~96 kbit/s on the wire). It edits our own SDP: each side states
// what it wants to receive.
const OPUS: Record<string, string> = { useinbandfec: '1', usedtx: '0', stereo: '0', maxaveragebitrate: '48000' };

export function tuneOpus(sdp: string): string {
  const pt = /^a=rtpmap:(\d+) opus\/48000/im.exec(sdp)?.[1];
  if (!pt) return sdp;
  const fmtp = new RegExp(`^a=fmtp:${pt} ([^\\r\\n]*)`, 'm');
  const merge = (cur: string) => {
    const params = new Map(cur ? cur.split(';').map((p) => p.trim().split('=') as [string, string]) : []);
    for (const [k, v] of Object.entries(OPUS)) params.set(k, v);
    return [...params].map(([k, v]) => `${k}=${v}`).join(';');
  };
  if (fmtp.test(sdp)) return sdp.replace(fmtp, (_, cur: string) => `a=fmtp:${pt} ${merge(cur)}`);
  return sdp.replace(new RegExp(`^(a=rtpmap:${pt} [^\\r\\n]*)`, 'm'), `$1\r\na=fmtp:${pt} ${merge('')}`);
}

// preferCodecs moves the listed codecs (lower-case MIME types) to the
// front; everything else (rtx, red, ulpfec) keeps the browser's order.
export function preferCodecs<T extends { mimeType: string }>(codecs: T[], order: string[]): T[] {
  const rank = (c: T) => {
    const i = order.indexOf(c.mimeType.toLowerCase());
    return i < 0 ? order.length : i;
  };
  return [...codecs].sort((a, b) => rank(a) - rank(b));
}

// videoOrder picks codecs the device encodes in hardware: H.264 on Apple
// (cooler phone, longer battery), VP8 on Android (hardware on most), VP9 on
// desktops (sharper picture per bit). A mobile answerer applies its own
// order; a desktop answerer follows the caller's, so whenever an iPhone or
// an Android phone is in the call, its choice wins.
export function videoOrder(ua: string): { order: string[]; mobile: boolean } {
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Version\/[\d.]+ .*Safari/.test(ua));
  if (apple) return { order: ['video/h264', 'video/vp8', 'video/vp9'], mobile: /iPhone|iPad|iPod|Mobile/.test(ua) };
  if (/Android/.test(ua)) return { order: ['video/vp8', 'video/h264', 'video/vp9'], mobile: true };
  return { order: ['video/vp9', 'video/vp8', 'video/h264'], mobile: false };
}

export type Level = 'good' | 'fair' | 'poor';

// rate: round-trip time in ms and packet loss in percent. Above ~400 ms a
// conversation trips over itself; above ~5 % loss voice breaks up.
export function rate(rttMs?: number, lossPct?: number): Level {
  const rtt = rttMs ?? 0;
  const loss = lossPct ?? 0;
  if (rtt > 400 || loss > 5) return 'poor';
  if (rtt > 250 || loss > 2) return 'fair';
  return 'good';
}

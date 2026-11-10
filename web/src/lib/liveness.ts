// A socket can die without closing: the laptop slept, the Wi-Fi changed, a
// NAT forgot it. The browser answers the server's pings by itself and the
// page never sees them, while a ring sent into the dead socket is lost and
// the server, which still hears pongs or not yet misses them, pushes nothing.
// So the page asks on its own: a silent socket is asked, and one that stays
// silent after asking is gone. Timers in a hidden tab may tick once a minute:
// only an unanswered question counts, never a late tick.
export const TICK_MS = 5000;
export const PING_AFTER_MS = 10_000;
export const DEAD_AFTER_MS = 8000;
export const CONNECT_MS = 15_000;

export interface Liveness {
  open: boolean;
  startedAt: number; // when the socket was created
  lastIn: number; // the last event it brought
  pingAt: number; // the last question asked
}

export function check(now: number, s: Liveness): 'wait' | 'ping' | 'dead' {
  if (!s.open) return now - s.startedAt >= CONNECT_MS ? 'dead' : 'wait';
  if (s.pingAt > s.lastIn) return now - s.pingAt >= DEAD_AFTER_MS ? 'dead' : 'wait';
  return now - s.lastIn >= PING_AFTER_MS ? 'ping' : 'wait';
}

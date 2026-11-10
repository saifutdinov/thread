import { signal } from '@preact/signals';

const events = new Set([
  'starting',
  'incoming',
  'media-request',
  'media-ready',
  'error',
  'connected',
  'disconnected',
  'ice-restart',
  'network-change',
  'signaling-open',
  'signaling-close',
  'reconnecting',
  'reconnected',
  'mic-muted',
  'mic-unmuted',
  'quality-good',
  'quality-fair',
  'quality-poor',
  'ended',
  'permission-denied',
  'device-unavailable',
  'media-error',
  'timeout',
] as const);
export type CallEvent = typeof events extends Set<infer T> ? T : never;
export interface HistoryEntry {
  at: number;
  event: CallEvent;
  rtt?: number;
  lossPct?: number;
  participants?: number;
}

// Local, bounded and allowlisted. No call ids, names, addresses or error text.
export class CallHistory {
  private entries: HistoryEntry[] = [];
  private started: number;
  private clock: () => number;
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.started = clock();
  }
  mark(event: CallEvent, values: Partial<Pick<HistoryEntry, 'rtt' | 'lossPct' | 'participants'>> = {}) {
    if (!events.has(event)) return;
    const entry: HistoryEntry = { at: Math.max(0, Math.round(this.clock() - this.started)), event };
    for (const k of ['rtt', 'lossPct', 'participants'] as const) {
      const n = values[k];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) entry[k] = n;
    }
    this.entries = [...this.entries.filter((e) => entry.at - e.at <= 120_000), entry].slice(-180);
  }
  snapshot() {
    const now = Math.max(0, Math.round(this.clock() - this.started));
    this.entries = this.entries.filter((e) => now - e.at <= 120_000);
    return this.entries.map((e) => ({ ...e }));
  }
}

// Explicit allowlist: never export candidates, SDP, addresses, identities or keys.
const fields = [
  'kind',
  'state',
  'candidateType',
  'protocol',
  'relayProtocol',
  'mimeType',
  'bytesReceived',
  'bytesSent',
  'packetsReceived',
  'packetsSent',
  'packetsLost',
  'jitter',
  'currentRoundTripTime',
  'roundTripTime',
  'availableOutgoingBitrate',
  'framesPerSecond',
  'frameWidth',
  'frameHeight',
  'framesDropped',
  'freezeCount',
  'totalFreezesDuration',
  'qualityLimitationReason',
  'audioLevel',
  'concealedSamples',
  'totalSamplesReceived',
] as const;
const types = new Set([
  'transport',
  'candidate-pair',
  'local-candidate',
  'remote-candidate',
  'inbound-rtp',
  'outbound-rtp',
  'remote-inbound-rtp',
  'codec',
]);

export function safeStats(report: RTCStatsReport) {
  const out: Record<string, string | number>[] = [];
  report.forEach((s: Record<string, unknown>) => {
    if (!types.has(String(s.type))) return;
    const row: Record<string, string | number> = { type: String(s.type) };
    for (const k of fields)
      if (typeof s[k] === 'string' || (typeof s[k] === 'number' && Number.isFinite(s[k]))) row[k] = s[k] as string | number;
    out.push(row);
  });
  return out;
}

function bundle(
  kind: 'direct' | 'group',
  reports: RTCStatsReport[],
  state: Record<string, string | number | boolean>,
  history: HistoryEntry[],
) {
  return { version: 2, kind, browser: navigator.userAgent, state, history, reports: reports.map(safeStats) };
}
type Diagnostic = ReturnType<typeof bundle>;
export const lastDiagnostics = signal<Diagnostic | null>(null);
let generation = 0;
export function clearDiagnostics() {
  generation++;
  lastDiagnostics.value = null;
}

export function beginDiagnostics(kind: 'direct' | 'group') {
  const mine = ++generation;
  const history = new CallHistory();
  return {
    mark: history.mark.bind(history),
    snapshot: () => history.snapshot(),
    finish(reports: Promise<RTCStatsReport[]>, state: Record<string, string | number | boolean> = {}) {
      history.mark('ended');
      const timeline = history.snapshot();
      // Keep the failure timeline available even if the RTC thread never
      // completes getStats. Enrich it when counters become available.
      if (mine === generation) lastDiagnostics.value = bundle(kind, [], state, timeline);
      void reports
        .catch(() => [])
        .then((reports) => {
          if (mine === generation) lastDiagnostics.value = bundle(kind, reports, state, timeline);
        });
    },
  };
}

function download(data: Diagnostic) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  // save.ts inlined: this module has no local imports, its tests run under plain Node.
  const app = (globalThis as { connectApp?: { save?(url: string, name: string): void } }).connectApp;
  if (app?.save) app.save(url, 'thread-call-diagnostics.json');
  else {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'thread-call-diagnostics.json';
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
}

export function downloadDiagnostics(
  kind: 'direct' | 'group',
  reports: RTCStatsReport[],
  state: Record<string, string | number | boolean>,
  history: HistoryEntry[] = [],
) {
  download(bundle(kind, reports, state, history));
}
export function downloadLastDiagnostics() {
  if (lastDiagnostics.value) download(lastDiagnostics.value);
}

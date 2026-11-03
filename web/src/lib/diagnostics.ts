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

export function downloadDiagnostics(kind: 'direct' | 'group', reports: RTCStatsReport[], state: Record<string, string | number | boolean>) {
  const data = { version: 1, kind, browser: navigator.userAgent, state, reports: reports.map(safeStats) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'thread-call-diagnostics.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

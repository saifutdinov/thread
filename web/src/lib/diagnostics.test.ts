import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeStats } from './diagnostics.ts';

test('diagnostics retain quality counters but never addresses, SDP, ids or unknown fields', () => {
  const report = new Map([
    [
      'secret',
      {
        type: 'local-candidate',
        id: 'user.device',
        address: '192.168.0.1',
        port: 5555,
        url: 'turn:private',
        candidateType: 'relay',
        protocol: 'udp',
        sdp: 'secret',
        credential: 'secret',
      },
    ],
    ['media', { type: 'inbound-rtp', packetsLost: 4, jitter: 0.02, trackIdentifier: 'secret' }],
  ]) as unknown as RTCStatsReport;
  assert.deepEqual(safeStats(report), [
    { type: 'local-candidate', candidateType: 'relay', protocol: 'udp' },
    { type: 'inbound-rtp', packetsLost: 4, jitter: 0.02 },
  ]);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { rate } from './rtc.ts';

test('diagnostic history does not record healthy quality from stalled or disconnected RTC samples', async () => {
  let packets = 10;
  const events: string[] = [];
  const peer = { connectionState: 'connected', getStats: async () => new Map<string, unknown>([
    ['transport',{type:'transport',selectedCandidatePairId:'pair'}],
    ['pair',{type:'candidate-pair',currentRoundTripTime:.05}],
    ['audio',{type:'inbound-rtp',kind:'audio',bytesReceived:packets*100,packetsReceived:packets,packetsLost:0}],
  ]) };
  const source = readFileSync(new URL('./call.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.slice(source.indexOf('async function sample()'),source.indexOf('async function flushIce()')));
  const context = vm.createContext({pc:peer, prev:null, rate, history:{mark:(name:string)=>events.push(name)}, call:{value:{reconnecting:false}}, update(){}, updateNetwork(){}, Date});
  vm.runInContext(code + '\nglobalThis.sampleStats=sample;',context);
  const sample = context.sampleStats as () => Promise<void>;
  await sample(); packets=20; await sample(); await sample();
  packets=30; peer.connectionState='disconnected'; await sample();
  assert.deepEqual(events,['quality-good']);
});

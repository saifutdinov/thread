import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import dgram from 'node:dgram';

test('call fixture reads split process log records and bounds retained errors', () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const logs: string[] = [];
  const context = vm.createContext({ spawn: () => child, repo: '.', process: { env: {} }, processes: new Set(), errors: [], logs });
  const source = readFileSync(new URL('../../scripts/call-failures.mjs', import.meta.url), 'utf8');
  vm.runInContext(
    'let bootstrap;\n' +
      source.slice(source.indexOf('function launch('), source.indexOf('async function stop(')) +
      '\nlaunch("fixture", []);globalThis.invite=()=>bootstrap;',
    context,
  );
  child.stdout.write('{"url":"http://local');
  child.stdout.write('host/#/i/test"}\n');
  assert.equal((context.invite as () => string)(), 'http://localhost/#/i/test');
  for (let i = 0; i < 100; i++) child.stderr.write(`error ${i}\n`);
  assert.equal(logs.length, 50);
  assert.match(logs[0], /error 50/);
  child.stdout.destroy();
  child.stderr.destroy();
});

test('LiveKit override bypasses unsupported platform checks and downloads', () => {
  const source = readFileSync(new URL('../../scripts/install-livekit.mjs', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const exited = new Error('exit');
  const output: string[] = [];
  const context = vm.createContext({
    process: {
      env: { LIVEKIT_BINARY: '/custom/livekit' },
      arch: 'arm64',
      platform: 'darwin',
      exit: () => {
        throw exited;
      },
    },
    console: { log: (s: string) => output.push(s) },
  });
  assert.throws(
    () => vm.runInContext(source.slice(0, source.indexOf('const assets')), context),
    (e) => e === exited,
  );
  assert.deepEqual(output, ['/custom/livekit']);
});

test('SFU media port is probed with UDP rather than TCP', async () => {
  const source = readFileSync(new URL('../../scripts/call-failures.mjs', import.meta.url), 'utf8');
  let udp = 0;
  const context = vm.createContext({
    net: {
      createServer: () => {
        throw new Error('unexpected TCP probe');
      },
    },
    dgram: {
      createSocket: () => {
        udp++;
        return dgram.createSocket('udp4');
      },
    },
  });
  vm.runInContext(
    source.slice(source.indexOf('const freePort ='), source.indexOf('const port =')) + '\nglobalThis.probe = freePort;',
    context,
  );
  const port = await (context.probe as (protocol: string) => Promise<number>)('udp');
  assert.equal(udp, 1);
  assert.ok(port > 0);
  assert.match(source, /mediaPort = await freePort\('udp'\)/);
});

test('termination closes owned browsers and child processes once', async () => {
  const source = readFileSync(new URL('../../scripts/call-failures.mjs', import.meta.url), 'utf8');
  const proc = new EventEmitter() as EventEmitter & { exit: (code: number) => void };
  let closed = 0,
    stopped = 0;
  let exitCode = 0;
  const exited = new Promise<void>((resolve) => {
    proc.exit = (code) => {
      exitCode = code;
      resolve();
    };
  });
  const context = vm.createContext({
    process: proc,
    console: { error() {} },
    dir: '/tmp/fixture',
    contexts: [
      {
        close: async () => {
          closed++;
        },
      },
    ],
    processes: new Set([{}]),
    stop: async () => {
      stopped++;
    },
  });
  vm.runInContext(
    source.slice(source.indexOf('let cleanupPromise;'), source.indexOf('async function eventually(')) + '\nglobalThis.clean = cleanup;',
    context,
  );
  proc.emit('SIGTERM');
  await exited;
  await (context.clean as () => Promise<unknown>)();
  assert.equal(exitCode, 143);
  assert.equal(closed, 1);
  assert.equal(stopped, 1);
});

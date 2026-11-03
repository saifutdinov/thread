import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHTTPServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('Vite forwards LiveKit HTTP and WebSocket signaling to Go', { timeout: 15000 }, async () => {
  const sockets = new Set<Duplex>();
  const paths: string[] = [];
  const backend = createHTTPServer((req, res) => {
    paths.push(req.url!);
    res.end('livekit-http');
  });
  backend.on('upgrade', (req, socket) => {
    paths.push(req.url!);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n',
    );
    const payload = Buffer.from('livekit-ws');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  backend.listen(8080);
  await once(backend, 'listening');
  const vite = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  let ws: WebSocket | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer!.address() as { port: number };
    const origin = `127.0.0.1:${address.port}`;
    assert.equal(await (await fetch(`http://${origin}/lk/probe?kind=http`)).text(), 'livekit-http');
    const message = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket proxy timed out')), 5000);
      ws = new WebSocket(`ws://${origin}/lk/probe?kind=ws`);
      ws.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      };
      ws.onerror = (event) => {
        clearTimeout(timeout);
        reject(event);
      };
    });
    assert.equal(message, 'livekit-ws');
    assert.deepEqual(paths, ['/lk/probe?kind=http', '/lk/probe?kind=ws']);
  } finally {
    ws?.close();
    for (const socket of sockets) socket.destroy();
    await vite.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});

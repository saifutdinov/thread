import path from 'node:path';

// The interface comes from inside the app, not from the server: a broken
// server cannot hand the app altered code. Same origin as the server, so the
// session cookie, the WebSocket and the server's origin checks stay as they
// are. Only the server's API reaches it: it answers any other path with its
// own index.html, whose code must never run on the app's origin.
export const toServer = (url, origin) =>
  url.origin === origin &&
  (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname === '/healthz' || url.pathname === '/lk' || url.pathname.startsWith('/lk/'));

// The bundled file for a request to the app's origin, or null: a 404.
export function bundled(url, origin, root, exists) {
  if (url.origin !== origin) return null;
  let name;
  try {
    name = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (name.includes('\0')) return null;
  if (name === '/') name = '/index.html';
  const file = path.resolve(root, '.' + path.posix.normalize(name));
  if (!file.startsWith(root + path.sep) || !exists(file)) return null;
  return file;
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

// The same policy the server sends (internal/server/server.go, secure).
export function headersFor(file, origin) {
  const host = new URL(origin).host;
  return {
    'content-type': types[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy':
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
      `img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss://${host} ws://${host}; ` +
      "worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

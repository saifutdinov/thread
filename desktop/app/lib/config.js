// The one server this app trusts with the person's keys: an https origin, or
// http on this computer for development. Anything else is refused, so a
// mistyped or planted address cannot get the interface or the session.
export function parseOrigin(text) {
  const url = new URL(String(text));
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('origin: https only');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('origin: no path, query or credentials');
  }
  return url.origin;
}

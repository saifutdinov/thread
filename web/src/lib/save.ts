// saveFile hands a file to the downloads: the browser's, or the Android
// app's (a WebView ignores <a download>; pwa.ts NativeApp.save). No imports:
// diagnostics.ts and its tests load this under plain Node.
export function saveFile(url: string, name: string) {
  const app = (globalThis as { connectApp?: { save?(url: string, name: string): void } }).connectApp;
  if (app?.save) return app.save(url, name);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

// latest runs fn once at a time; calls while it runs make one more run
// after it, with things as they are by then (a microphone reopened after a
// slider drag, the vault read again after a burst of changes).
export function latest(fn: () => Promise<void>) {
  let busy: Promise<void> | null = null;
  let again = false;
  return function run(): Promise<void> {
    if (busy) {
      again = true;
      return busy;
    }
    busy = (async () => {
      do {
        again = false;
        try {
          await fn();
        } catch (e) {
          if (!again) throw e; // asked again meanwhile: that run goes on
        }
      } while (again);
    })().finally(() => (busy = null));
    return busy;
  };
}

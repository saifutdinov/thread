// One key-value store in IndexedDB. The service worker (public/sw.js) reads
// the same database to decrypt push notifications, so keep names in sync.
//   device       -> StoredDevice (non-extractable CryptoKeys)
//   k:<chat>:<e> -> raw chat key bytes
//   lang         -> UI language for notifications
//   names        -> { [user id]: the name I gave them } (store.ts ownNames; the vault syncs it)
//   namesDirty   -> { [user id]: changes here not in the vault yet }
//   namesSynced  -> true once this device's names went into the vault
//   vaultSeen    -> { e, v }: the newest vault epoch and version read here (no rollback)
//   push:<chat>  -> PushNote (store.ts): the chat's name and icon for notifications
//   gjoin        -> { c, id, at }: "Join" tapped on a group call's notification (sw.js, group.ts)

const DB = 'thread';
const STORE = 'kv';

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

// written: told of every write, after it lands (the Android app copies the
// keys its pushes need, android.ts). A clear is reported as key "*".
let written: ((k: string, v: unknown) => void) | null = null;
export const watchIdb = (fn: typeof written) => (written = fn);

export const idbGet = <T>(k: string) => run<T | undefined>('readonly', (s) => s.get(k));
export const idbSet = (k: string, v: unknown) => run<void>('readwrite', (s) => s.put(v, k)).then(() => written?.(k, v));
export const idbClear = () => run<void>('readwrite', (s) => s.clear()).then(() => written?.('*', null));
export const idbKeys = () => run<string[]>('readonly', (s) => s.getAllKeys());

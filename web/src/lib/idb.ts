// One key-value store in IndexedDB. The service worker (public/sw.js) reads
// the same database to decrypt push notifications, so keep names in sync.
//   device       -> StoredDevice (non-extractable CryptoKeys)
//   k:<chat>:<e> -> raw chat key bytes
//   lang         -> UI language for notifications

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

export const idbGet = <T>(k: string) => run<T | undefined>('readonly', (s) => s.get(k));
export const idbSet = (k: string, v: unknown) => run<void>('readwrite', (s) => s.put(v, k));
export const idbClear = () => run<void>('readwrite', (s) => s.clear());
export const idbKeys = () => run<string[]>('readonly', (s) => s.getAllKeys());

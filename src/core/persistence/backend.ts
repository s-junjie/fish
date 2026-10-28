export type StoreName = "recovery" | "assets" | "handles" | "meta" | "versions" | "backups";

export interface KVBackend {
  put(store: StoreName, value: unknown): Promise<void>;
  get(store: StoreName, key: string): Promise<unknown | undefined>;
  getAll(store: StoreName): Promise<unknown[]>;
  delete(store: StoreName, key: string): Promise<void>;
  clearStore(store: StoreName): Promise<void>;
}

const DB_NAME = "fish-autosave";
// Bumped for the `backups` store. `onupgradeneeded` only adds what is missing,
// so existing recovery/history rows survive the upgrade.
const DB_VERSION = 2;

let idbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open the shared database, or fail loudly.
 *
 * Two things here are load-bearing, and both were missing:
 *
 * `onblocked` — every `file://` page shares one origin and one database, so a
 * second tab holding a connection at an older version blocks the upgrade. That
 * event has no default and no counterpart: without a handler the request never
 * settles, the promise never resolves *or* rejects, and every caller waits
 * forever. In the auto-save controller that is fatal rather than slow — `flush()`
 * awaits the snapshot with `flushing = true`, so one blocked upgrade silently
 * ends auto-saving for the rest of the session.
 *
 * Not caching a failure — the promise is module-level, so a single blocked or
 * errored attempt would otherwise be handed to every later call. Rejecting
 * without caching means the next edit retries, which is what recovers once the
 * other tab closes.
 */
function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("indexedDB unavailable in this environment"));
  }
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => reject(new Error(`indexedDB upgrade to v${DB_VERSION} is blocked by another tab`));
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["recovery", "assets", "handles", "meta", "versions", "backups"] as StoreName[]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
  idbPromise = idbPromise.catch((err) => {
    idbPromise = null;
    throw err;
  });
  return idbPromise;
}

function tx(db: IDBDatabase, store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

export class IdbBackend implements KVBackend {
  async put(store: StoreName, value: unknown): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const os = tx(db, store, "readwrite");
      os.put(value);
      os.transaction.oncomplete = () => resolve();
      os.transaction.onerror = () => reject(os.transaction.error);
    });
  }

  async get(store: StoreName, key: string): Promise<unknown | undefined> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const os = tx(db, store, "readonly");
      const req = os.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(store: StoreName): Promise<unknown[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const os = tx(db, store, "readonly");
      const req = os.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(store: StoreName, key: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const os = tx(db, store, "readwrite");
      os.delete(key);
      os.transaction.oncomplete = () => resolve();
      os.transaction.onerror = () => reject(os.transaction.error);
    });
  }

  async clearStore(store: StoreName): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const os = tx(db, store, "readwrite");
      os.clear();
      os.transaction.oncomplete = () => resolve();
      os.transaction.onerror = () => reject(os.transaction.error);
    });
  }
}

export class MemoryBackend implements KVBackend {
  private maps: Record<StoreName, Map<string, unknown>> = {
    recovery: new Map(),
    assets: new Map(),
    handles: new Map(),
    meta: new Map(),
    versions: new Map(),
    backups: new Map()
  };

  async put(store: StoreName, value: unknown): Promise<void> {
    const key = (value as { key: string }).key;
    this.maps[store].set(key, value);
  }

  async get(store: StoreName, key: string): Promise<unknown | undefined> {
    return this.maps[store].get(key);
  }

  async getAll(store: StoreName): Promise<unknown[]> {
    return [...this.maps[store].values()];
  }

  async delete(store: StoreName, key: string): Promise<void> {
    this.maps[store].delete(key);
  }

  async clearStore(store: StoreName): Promise<void> {
    this.maps[store].clear();
  }
}

export function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

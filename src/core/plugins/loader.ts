/**
 * Install once, run from the copy on disk.
 *
 * Every load starts from bytes — never from a URL. The file is verified, the
 * store keeps the code, and the only thing the browser ever executes is a
 * `blob:` URL built from bytes whose SHA-256 was just recomputed. Three
 * consequences follow, and all three are the point:
 *
 * - online, offline and "opened from another file" are the same code path;
 * - the gate applies to what actually runs, not to a URL that could answer
 *   differently on the second request;
 * - a row edited in the browser's storage does not become code, because the
 *   hash is checked again on the way out.
 *
 * There is no catalog here on purpose: a plugin file carries its own signed
 * manifest, so the shell can install a plugin it has never heard of and still be
 * sure who published it.
 *
 * The module arrives as one file: a `blob:` module has no base URL, so a relative
 * `import()` inside it fails to resolve (measured — see
 * `docs/PLUGIN_DISTRIBUTION_PLAN.md` §1). `scripts/build-plugin.mjs` enforces that
 * by bundling with code splitting off.
 */
import {
  assertModule,
  assertUsable,
  PluginRejected,
  sha256Hex,
  verifyPluginFile,
  type PluginManifest,
  type PluginModule
} from "./manifest";
import { pluginPublicKey } from "./plugin-key";

export interface InstalledRecord {
  id: string;
  manifest: PluginManifest;
  bytes: ArrayBuffer;
  installedAt: number;
}

const DB_NAME = "fish-plugins";
const STORE_NAME = "bundles";
const DB_VERSION = 1;

export interface PluginStorage {
  put(record: InstalledRecord): Promise<void>;
  get(id: string): Promise<InstalledRecord | undefined>;
  getAll(): Promise<InstalledRecord[]>;
  delete(id: string): Promise<void>;
}

let idb: Promise<IDBDatabase> | null = null;

/**
 * Same two lessons as `core/persistence/backend.ts`, for the same reason: every
 * `file://` page shares one origin and one database, so a second tab holding an
 * older connection makes the upgrade block. `onblocked` has no default, and a
 * request that never settles would hang the plugin list forever rather than fail.
 * A rejection is not cached, so the next call retries once that tab closes.
 */
function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new PluginRejected("IndexedDB is unavailable in this environment", "shape"));
  }
  if (idb) return idb;
  idb = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => reject(new Error(`plugin storage upgrade to v${DB_VERSION} is blocked by another tab`));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("plugin storage open failed"));
  });
  idb = idb.catch((err) => {
    idb = null;
    throw err;
  });
  return idb;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = fn(tx.objectStore(STORE_NAME));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export const idbStorage: PluginStorage = {
  put: (record) => run("readwrite", (s) => s.put(record)).then(() => undefined),
  get: (id) => run<InstalledRecord | undefined>("readonly", (s) => s.get(id) as IDBRequest<InstalledRecord | undefined>),
  getAll: () => run<InstalledRecord[]>("readonly", (s) => s.getAll() as IDBRequest<InstalledRecord[]>),
  delete: (id) => run("readwrite", (s) => s.delete(id)).then(() => undefined)
};

export function memoryStorage(seed: InstalledRecord[] = []): PluginStorage {
  const rows = new Map(seed.map((r) => [r.id, r]));
  return {
    put: async (r) => void rows.set(r.id, r),
    get: async (id) => rows.get(id),
    getAll: async () => Array.from(rows.values()),
    delete: async (id) => void rows.delete(id)
  };
}

let storage: PluginStorage = idbStorage;
// The baked key is a build-time constant; tests inject their own so a fixture can
// be signed and installed without building a shell.
let keyOverride: JsonWebKey | null | undefined;

/** Tests swap the backend and the key; nothing else is allowed to. */
export function setPluginStorage(next: PluginStorage | null): void {
  storage = next ?? idbStorage;
  modules.clear();
}

export function setPluginKey(next: JsonWebKey | null): void {
  keyOverride = next;
  modules.clear();
}

function trustAnchor(): JsonWebKey | null {
  return keyOverride === undefined ? pluginPublicKey() : keyOverride;
}

const modules = new Map<string, { manifest: PluginManifest; mod: PluginModule }>();

/**
 * Verify a signed file and store its code. This is the only way in: there is no
 * variant that accepts a manifest and a blob separately, because that pair could
 * disagree and the disagreement would be the bug.
 */
export async function installPlugin(bytes: ArrayBuffer): Promise<InstalledRecord> {
  const { manifest, code } = await verifyPluginFile(bytes, trustAnchor());
  const record: InstalledRecord = { id: manifest.id, manifest, bytes: code, installedAt: Date.now() };
  await storage.put(record);
  modules.delete(manifest.id);
  return record;
}

/** A picked file is just bytes; what it is comes from what it proves. */
export async function installFromFile(file: Blob): Promise<InstalledRecord> {
  return installPlugin(await file.arrayBuffer());
}

/** Fetch a plugin bundle from a URL and install it through the exact same verification. */
export async function installFromUrl(url: string, fetchImpl?: typeof globalThis.fetch): Promise<InstalledRecord> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const res = await doFetch(url);
  if (!res.ok) {
    throw new PluginRejected(`failed to download plugin from ${url} (status ${res.status})`, "shape");
  }
  const bytes = await res.arrayBuffer();
  return installPlugin(bytes);
}

export async function uninstallPlugin(id: string): Promise<void> {
  modules.delete(id);
  await storage.delete(id);
}

export async function installedRecords(): Promise<InstalledRecord[]> {
  return storage.getAll();
}

export async function openPlugin(id: string): Promise<{ manifest: PluginManifest; mod: PluginModule }> {
  const cached = modules.get(id);
  if (cached) return cached;

  const record = await storage.get(id);
  if (!record) throw new PluginRejected(`plugin ${id} is not installed`, "shape");
  assertUsable(record.manifest);

  const hex = await sha256Hex(record.bytes);
  if (hex !== record.manifest.sha256) {
    await storage.delete(id);
    throw new PluginRejected(`plugin ${id} on disk no longer matches its fingerprint; removed`, "corrupt");
  }

  const url = URL.createObjectURL(new Blob([record.bytes], { type: "text/javascript" }));
  try {
    const mod = assertModule(await import(/* @vite-ignore */ url), id);
    const opened = { manifest: record.manifest, mod };
    modules.set(id, opened);
    return opened;
  } finally {
    URL.revokeObjectURL(url);
  }
}

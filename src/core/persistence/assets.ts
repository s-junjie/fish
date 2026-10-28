import type { AssetRef, DesignDocument } from "../dsl/types";
import type { KVBackend } from "./backend";
import { cachedHash } from "./hash";

/**
 * A document as it is stored in a snapshot: the inline bitmaps are replaced by
 * their content hashes. Spelled out rather than cast, because a cast here means
 * `assets` looks like `AssetRef[]` while actually holding strings — and anything
 * that runs such a document through normalization would drop every asset
 * without a word.
 */
export type SnapshotDoc = Omit<DesignDocument, "assets"> & { assets?: string[] };

export interface AssetStore {
  put(ref: AssetRef): Promise<string>;
  getMany(hashes: string[]): Promise<(AssetRef | undefined)[]>;
  /** Increment the reference count for each hash (a version now owns it). */
  acquire(hashes: string[]): Promise<void>;
  /** Decrement reference counts; a hash with no remaining refs is deleted. */
  release(hashes: string[]): Promise<void>;
}

export function hashAsset(ref: AssetRef): string {
  // The URI is the only bulky, content-stable part; dims/name are derivable.
  // Cached: the value is persisted as the key a snapshot's bitmaps live under,
  // so it may never change, and re-hashing 39.6 MB of base64 per snapshot is the
  // difference between an idle save and 42 ms of blocked main thread.
  return "a" + cachedHash(ref.uri || ref.id || "");
}

interface AssetRow {
  key: string;
  ref: AssetRef;
  refCount: number;
}

class KVAssetStore implements AssetStore {
  /**
   * Rows this session has already read or written, keyed by content hash.
   *
   * A row carries the whole bitmap, so a `get` costs its size and a `put` writes
   * it again. Every snapshot asks about the same 107 hashes, so without this the
   * already-stored case paid a full read-and-rewrite per hash per save. `null`
   * records a miss, which is just as reusable: the row still does not exist.
   */
  private resident = new Map<string, AssetRow | null>();

  constructor(private backend: KVBackend) {}

  private async known(hash: string): Promise<AssetRow | undefined> {
    const cached = this.resident.get(hash);
    if (cached !== undefined) return cached ?? undefined;
    const row = (await this.backend.get("assets", hash)) as AssetRow | undefined;
    this.resident.set(hash, row ?? null);
    return row;
  }

  private async write(hash: string, row: AssetRow): Promise<void> {
    this.resident.set(hash, row);
    await this.backend.put("assets", row);
  }

  async put(ref: AssetRef): Promise<string> {
    const hash = hashAsset(ref);
    const existing = await this.known(hash);
    // Byte-identical ref under a hash it already occupies: the row is the row.
    // Comparing the fields that can change under one URI keeps a rename or a
    // measured duration from being frozen out.
    if (existing && sameStoredRef(existing.ref, ref)) return hash;
    await this.write(hash, { key: hash, ref, refCount: existing ? existing.refCount : 0 });
    return hash;
  }

  /**
   * Rehydration is the one read that must see the backing store as it is now: a
   * record outliving the bitmap it names is exactly the damage the callers above
   * check for, and a cached answer would hide it.
   */
  async getMany(hashes: string[]): Promise<(AssetRef | undefined)[]> {
    const rows = await Promise.all(
      hashes.map((h) => this.backend.get("assets", h) as Promise<AssetRow | undefined>)
    );
    return rows.map((r) => r?.ref);
  }

  async acquire(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      const existing = await this.known(hash);
      if (!existing) continue;
      await this.write(hash, { ...existing, refCount: existing.refCount + 1 });
    }
  }

  async release(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      const existing = await this.known(hash);
      if (!existing) continue;
      const next = existing.refCount - 1;
      if (next <= 0) {
        this.resident.delete(hash);
        await this.backend.delete("assets", hash);
      } else {
        await this.write(hash, { ...existing, refCount: next });
      }
    }
  }
}

/** Whether two refs would store the same bytes under the same hash. */
function sameStoredRef(a: AssetRef, b: AssetRef): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.uri === b.uri &&
      a.name === b.name &&
      a.width === b.width &&
      a.height === b.height &&
      a.duration === b.duration)
  );
}


export function createAssetStore(backend: KVBackend): AssetStore {
  return new KVAssetStore(backend);
}
/**
 * Replace a document's inline `assets` (which embed the full base64 URI) with a
 * list of content hashes. The actual asset bytes are stored once in the asset
 * store, so repeated snapshots of an unchanged document cost almost nothing.
 * `put` is idempotent and does NOT claim ownership — callers that persist a
 * snapshot must `acquire` the returned hashes and `release` them on discard.
 */
export async function toSnapshotAssets(
  doc: DesignDocument,
  assets: AssetStore
): Promise<{ doc: SnapshotDoc; hashes: string[] }> {
  const refs = doc.assets ?? [];
  const hashes: string[] = [];
  for (const ref of refs) {
    hashes.push(await assets.put(ref));
  }
  return { doc: { ...doc, assets: hashes }, hashes };
}

/** Inverse of {@link toSnapshotAssets}: rehydrate hashes back into asset refs. */
export async function fromSnapshotAssets(
  doc: SnapshotDoc,
  assets: AssetStore
): Promise<DesignDocument> {
  const refs = await assets.getMany(doc.assets ?? []);
  const restored: AssetRef[] = refs.map(
    (r, i) => r ?? { id: `missing_${i}`, name: "Missing asset", uri: "" }
  );
  // The cast is the Omit in `SnapshotDoc` losing the rest of the shape on spread.
  return { ...doc, assets: restored } as DesignDocument;
}

/**
 * True when a rehydrated snapshot still carries placeholder refs, i.e. its
 * bitmaps are no longer in the asset store. An asset without a URI cannot be
 * painted, so such a document renders every image layer blank.
 */
export function hasMissingAssets(doc: DesignDocument): boolean {
  return (doc.assets ?? []).some((a) => !a.uri);
}

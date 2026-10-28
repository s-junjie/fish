import type { KVBackend } from "./backend";
import type { AssetStore, SnapshotDoc } from "./assets";

export type VersionKind = "auto" | "named" | "pre-restore" | "restored";

export interface VersionRecord {
  id: string;
  docKey: string;
  forkId: string;
  /** Identity of the file, not of the document — survives a corrupt doc block. */
  fileId: string;
  label?: string;
  /**
   * `auto` is the debounced background record and is the only kind the merge
   * window may collapse. `pre-restore` is the safety snapshot taken just before
   * a restore — merging it would overwrite the version the user is restoring
   * *from*, i.e. the very history the snapshot exists to protect. `restored` is
   * the state that restore left behind: not an edit, and indistinguishable from
   * the next autosave if it borrows `auto`.
   */
  kind: VersionKind;
  named: boolean;
  createdAt: string;
  /**
   * Format and application versions this snapshot was written with. A restore
   * has to know whether the snapshot predates a format change before applying
   * it — the alternative is a document that loads but renders differently.
   */
  docVersion?: string;
  appVersion?: string;
  /**
   * When the merge group this record belongs to began. The merge window is
   * measured from here, not from `createdAt`: `createdAt` moves forward on every
   * merge, so measuring from it let the window slide indefinitely and a whole
   * editing session collapsed into a single version.
   */
  groupStartedAt?: string;
  /** Snapshot with deduped assets (assets = content-hash list). */
  doc: SnapshotDoc;
  /** The content hashes this version owns (for asset ref-counting). */
  assetHashes: string[];
  sizeBytes: number;
}

export interface TimelineStore {
  list(docKey: string): Promise<VersionRecord[]>;
  /** Every version, so forks the file has left behind can be reclaimed. */
  all(): Promise<VersionRecord[]>;
  get(id: string): Promise<VersionRecord | undefined>;
  put(rec: VersionRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

class KVTimelineStore implements TimelineStore {
  constructor(private backend: KVBackend) {}

  async put(rec: VersionRecord): Promise<void> {
    // Both backends key rows by `key` (IDB keyPath = "key"), so the storage key
    // must be stamped on the row or every version lands on the same undefined key.
    await this.backend.put("versions", { ...rec, key: rec.id });
  }

  async all(): Promise<VersionRecord[]> {
    return (await this.backend.getAll("versions")) as VersionRecord[];
  }

  async get(id: string): Promise<VersionRecord | undefined> {
    return (await this.backend.get("versions", id)) as VersionRecord | undefined;
  }

  async delete(id: string): Promise<void> {
    await this.backend.delete("versions", id);
  }

  async list(docKey: string): Promise<VersionRecord[]> {
    const all = (await this.backend.getAll("versions")) as VersionRecord[];
    return all
      .filter((v) => v.docKey === docKey)
      // Two commits can land in the same millisecond; ids carry a padded
      // monotonic sequence so the tiebreak still yields newest-first.
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
}

export function createTimelineStore(backend: KVBackend): TimelineStore {
  return new KVTimelineStore(backend);
}
export interface RetentionPolicy {
  /** Newest N versions are always kept regardless of age. */
  keepRecent: number;
  /** Hard cap on number of versions (oldest unnamed pruned first). */
  maxVersions: number;
  /** Hard cap on cumulative snapshot bytes (oldest unnamed pruned first). */
  maxBytes: number;
  /** Beyond keepRecent, keep at most one version per bucket of this size. */
  thinMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepRecent: 30,
  maxVersions: 200,
  maxBytes: 8 * 1024 * 1024,
  thinMs: 24 * 60 * 60 * 1000
};

function bucketOf(createdAt: string, thinMs: number): string {
  return Math.floor(Date.parse(createdAt) / thinMs).toString();
}

/**
 * Drop versions the user would never want, while keeping a Time-Machine-like
 * gradient: every recent version is kept; older ones are thinned to one-per
 * bucket; hard caps prune the oldest *unnamed* versions first. Named versions
 * are never auto-pruned. Returns the ids that were removed.
 */
export async function applyRetention(
  timeline: TimelineStore,
  assets: AssetStore,
  docKey: string,
  policy: RetentionPolicy = DEFAULT_RETENTION
): Promise<string[]> {
  const all = await timeline.list(docKey);
  const named = all.filter((v) => v.named);
  const unnamed = all.filter((v) => !v.named);

  const keep = new Set<string>(named.map((v) => v.id));
  unnamed.forEach((v, i) => {
    if (i < policy.keepRecent) keep.add(v.id);
  });
  // Thin the remainder so only one version per bucket survives.
  const seenBucket = new Set<string>();
  unnamed.forEach((v, i) => {
    if (i < policy.keepRecent) return;
    const b = bucketOf(v.createdAt, policy.thinMs);
    if (!seenBucket.has(b)) {
      seenBucket.add(b);
      keep.add(v.id);
    }
  });

  // Hard caps: prune oldest unnamed first.
  let retained = all.filter((v) => keep.has(v.id));
  const byAgeAsc = [...retained].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (retained.length > policy.maxVersions) {
    const target = byAgeAsc.find((v) => keep.has(v.id) && !v.named);
    if (!target) break;
    keep.delete(target.id);
    retained = retained.filter((r) => r.id !== target.id);
  }
  let totalBytes = retained.reduce((s, v) => s + v.sizeBytes, 0);
  for (const v of byAgeAsc) {
    if (totalBytes <= policy.maxBytes) break;
    if (keep.has(v.id) && !v.named) {
      keep.delete(v.id);
      retained = retained.filter((r) => r.id !== v.id);
      totalBytes -= v.sizeBytes;
    }
  }

  const removed = all.filter((v) => !keep.has(v.id));
  for (const v of removed) {
    await timeline.delete(v.id);
    await assets.release(v.assetHashes);
  }
  return removed.map((v) => v.id);
}

export function estimateSize(rec: Omit<VersionRecord, "sizeBytes">): number {
  return new TextEncoder().encode(JSON.stringify(rec)).length;
}

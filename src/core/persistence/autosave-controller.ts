import type { DesignDocument } from "../dsl/types";
import type { RecoveryStore } from "./recovery";
import { computeContentHash, resolveFork, type ForkResolution, type RecoveryRecord } from "./recovery";
import type { AssetStore } from "./assets";
import { toSnapshotAssets, fromSnapshotAssets, hasMissingAssets, type SnapshotDoc } from "./assets";
import { writeBackFile, saveDocAsNewFile, type WritebackPermission } from "./writeback";
import {
  applyRetention,
  estimateSize,
  type RetentionPolicy,
  type TimelineStore,
  type VersionKind,
  type VersionRecord
} from "./timeline";
import { DEFAULT_RETENTION } from "./timeline";
import { APP_VERSION } from "../version";
import { normalizeDesignDocument } from "../dsl/normalize";
import { t } from "../../i18n";

// Every kind here is one `emit` actually reaches. A member the machine cannot
// produce is a state a view will write a branch for and a reader will then treat
// as a real thing — which is how "Auto-save off" ended up wired to a `disabled`
// kind that no code path ever emitted, and the state a fresh tab is genuinely in
// went unshown because nothing reported it. Write-back being off is
// `file-unavailable`, which the controller does emit.
export type AutosaveStatus =
  | { kind: "local-saving" }
  | { kind: "local-saved"; at: string }
  | { kind: "file-writing" }
  | { kind: "file-saved"; at: string }
  | { kind: "file-unavailable"; reason: string }
  | { kind: "error"; message: string };

export interface VersionSummary {
  id: string;
  createdAt: string;
  label?: string;
  kind: VersionKind;
  named: boolean;
  sizeBytes: number;
}

export interface AutosaveControllerOptions {
  getDoc: () => DesignDocument;
  subscribe: (cb: (doc: DesignDocument) => void) => () => void;
  recovery: RecoveryStore;
  assets: AssetStore;
  /** Identity of the *file*, not of the document — see `getFileId`. */
  fileId: () => string;
  /**
   * `computePayloadHash` of the file as it was opened. The fork anchor has to be
   * a property of the file: deriving it from the document makes an engine change
   * fork every existing file. Omitted, the anchor falls back to the document.
   */
  getFilePayloadHash?: () => string | undefined;
  onStatus?: (status: AutosaveStatus) => void;
  idleMs?: number;
  maxWaitMs?: number;
  writebackEnabled?: boolean;
  // P2 — version timeline
  timeline?: TimelineStore;
  /**
   * The document to write to the file, when it is not the one `getDoc` reports.
   *
   * The editor passes one carrying the current page's viewport so a reopened
   * file comes back where its author left it. Deliberately NOT `getDoc`: the
   * recovery snapshot and the fork identity answer "has the content changed",
   * and a viewport that moved on its own is not a change to the content.
   */
  getWritebackDoc?: () => DesignDocument;
  /** Subscribe to editor history boundaries (one logical operation). */
  historySubscribe?: (cb: (doc: DesignDocument) => void) => () => void;
  /** Apply a restored document through the editor (records an undo step). */
  applyDoc?: (doc: DesignDocument) => void;
  retention?: Partial<RetentionPolicy>;
  /** Versions created within this window of the previous one overwrite it. */
  mergeWindowMs?: number;
  /** Notify the UI when the version list changes. */
  onTimeline?: (versions: VersionSummary[]) => void;
  /**
   * The comment block to carry in the recovery snapshot.
   *
   * Comments live outside the document (their own `#fish-comments` block), so
   * nothing in the doc snapshot holds them. Optional: a caller with no comments
   * stores none, and the record stays exactly as it was.
   */
  getComments?: () => unknown;
}

export type AutosaveControllerOptionsInput = Partial<AutosaveControllerOptions>;

export class AutosaveController {
  private idleMs: number;
  private maxWaitMs: number;
  private writebackEnabled: boolean;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private versionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `restoreVersion`, spent by the record that restore's apply arms. */
  private pendingRestoreKind = false;
  private unsubscribe: (() => void) | null = null;
  private historyUnsub: (() => void) | null = null;
  private flushing = false;
  /** True while a flush is queued, so a burst of schedules coalesces into one. */
  private flushQueued = false;
  /**
   * Serialises every recovery write. `flush` and `noteFileSaved` both overwrite
   * the same snapshot and ref-count the same assets; run together they acquired
   * and released the same hashes concurrently, which is what left the record and
   * its bitmaps disagreeing.
   */
  private queueTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private timeline?: TimelineStore;
  private policy: RetentionPolicy;
  private mergeWindowMs: number;
  private versionSeq = Date.now();
  /**
   * Resolved once per session (see `resolveFork`). Cached because the fork is a
   * property of the *file* that was opened — re-resolving it after an edit would
   * see a different hash every time and fork the whole history onto a new key.
   */
  private identity: ForkResolution | null = null;
  private identityDocId = "";

  constructor(private opts: AutosaveControllerOptions) {
    this.idleMs = opts.idleMs ?? 2000;
    this.maxWaitMs = opts.maxWaitMs ?? 30000;
    this.writebackEnabled = opts.writebackEnabled ?? false;
    this.timeline = opts.timeline;
    this.policy = { ...DEFAULT_RETENTION, ...(opts.retention ?? {}) };
    this.mergeWindowMs = opts.mergeWindowMs ?? 5 * 60 * 1000;
  }

  private emit(status: AutosaveStatus) {
    this.opts.onStatus?.(status);
  }

  private runQueued<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(task, task);
    this.queueTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async ensureIdentity(): Promise<ForkResolution> {
    const fileId = this.opts.fileId();
    if (this.identity && this.identityDocId === fileId) return this.identity;
    const resolved = await resolveFork(
      fileId,
      this.opts.getDoc(),
      this.opts.recovery,
      this.opts.getFilePayloadHash?.()
    );
    this.identity = resolved;
    this.identityDocId = fileId;
    return resolved;
  }

  /** Await before reading recovery/history so the fork is settled. */
  async ready(): Promise<void> {
    await this.ensureIdentity();
  }

  /**
   * The file on disk now holds `doc` (a successful Cmd+S or write-back). Move the
   * fork anchor and refresh the recovery snapshot together: without the anchor a
   * later boot would treat our own write as a foreign edit and fork; without the
   * refreshed snapshot it would offer to "recover" into a pre-save state.
   *
   * `payloadHash` is the hash of the bytes that actually landed (`computePayloadHash`
   * of the written payload). Without it nothing is re-anchored — the export path
   * writes to a new file and leaves this one alone, so its anchor still describes
   * the file a later boot will read.
   */
  async noteFileSaved(doc: DesignDocument, payloadHash?: string): Promise<void> {
    await this.runQueued(async () => {
      await this.persistRecovery(doc);
      if (payloadHash) await this.anchorToFile(payloadHash);
    });
  }

  private async anchorToFile(payloadHash: string): Promise<void> {
    await this.opts.recovery.setFileContentHash(this.opts.fileId(), payloadHash);
    if (this.identity) this.identity = { ...this.identity, fileContentHash: payloadHash };
  }

  enable(): void {
    if (this.unsubscribe) return;
    this.disposed = false;
    this.unsubscribe = this.opts.subscribe(() => this.schedule());
    if (this.opts.historySubscribe && this.timeline) {
      this.historyUnsub = this.opts.historySubscribe(() => this.scheduleVersion());
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onUnload);
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  disable(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.historyUnsub?.();
    this.historyUnsub = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onUnload);
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.clearTimers();
    this.clearVersionTimer();
  }

  /**
   * Arm or disarm file write-back. `flush: false` is for the paths that have
   * *just* written the file themselves — a `⌘S`, a save-as, or enabling after
   * the activation write — where the implicit flush would serialize and write
   * the same bytes a second time.
   */
  setWritebackEnabled(enabled: boolean, opts: { flush?: boolean } = {}): void {
    this.writebackEnabled = enabled;
    if (enabled && opts.flush !== false) void this.flush();
  }

  /**
   * Another tab now owns the file. Stop writing to disk but persist whatever
   * the debounce still holds, so becoming a follower does not discard the edits
   * made in the last few seconds.
   */
  async suspendWriteback(): Promise<void> {
    this.writebackEnabled = false;
    await this.flush();
  }

  isWritebackEnabled(): boolean {
    return this.writebackEnabled;
  }

  private onUnload = (): void => {
    void this.flush();
  };

  private onVisibility = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      void this.flush();
    }
  };

  private schedule(): void {
    if (this.disposed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.flush(), this.idleMs);
    // Armed only when nothing is pending. Re-arming it on every change would
    // measure "time since the last change" instead of "time since the last
    // flush", so a user typing continuously for minutes would never persist.
    if (!this.maxTimer) this.maxTimer = setTimeout(() => void this.flush(), this.maxWaitMs);
  }

  /**
   * Cancels the *recovery* timers only. The version timer is deliberately left
   * alone: `schedule()` runs on every document change, and a commit notifies
   * history (arming the version timer) immediately before notifying subscribers
   * (calling `schedule()`), so clearing it here would cancel the version the
   * same commit just asked for — leaving only gesture-driven edits recorded.
   */
  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.idleTimer = null;
    this.maxTimer = null;
  }

  private clearVersionTimer(): void {
    if (this.versionTimer) clearTimeout(this.versionTimer);
    this.versionTimer = null;
  }

  async flushNow(): Promise<void> {
    await this.flush();
  }

  /**
   * Write the single recovery snapshot. The snapshot claims its assets *before*
   * the previous set is released: the record is overwritten in place, so an
   * unchanged asset would otherwise be released down to 0 and deleted, taking
   * the bitmap out from under the very snapshot that still lists its hash — and
   * the next restore would resolve it to a "Missing asset" placeholder.
   *
   * What the previous snapshot held is read back from the store rather than
   * remembered in a field: the field was empty at the start of every session,
   * so the first flush of each session released nothing and the refcounts
   * ratcheted upward forever — assets were never reclaimed.
   */
  private async persistRecovery(doc: DesignDocument): Promise<string> {
    const { docKey, forkId } = await this.ensureIdentity();
    const previous = await this.opts.recovery.load(docKey);
    const { doc: snapshotDoc, hashes } = await toSnapshotAssets(doc, this.opts.assets);
    const record: RecoveryRecord = {
      key: docKey,
      docKey,
      fileId: this.opts.fileId(),
      forkId,
      updatedAt: new Date().toISOString(),
      doc: snapshotDoc,
      assetHashes: hashes,
      docVersion: doc.version,
      appVersion: APP_VERSION,
      comments: this.opts.getComments?.()
    };
    await this.opts.recovery.save(record);
    // Re-claiming the set the previous snapshot already holds is a no-op that
    // costs a read and a full-row write per hash — 107 round trips carrying a
    // bitmap each on the measured file, for a document whose images did not
    // change. Only a different set has refcounts to move.
    if (!sameHashSet(previous?.assetHashes, hashes)) {
      await this.opts.assets.acquire(hashes);
      if (previous?.assetHashes) await this.opts.assets.release(previous.assetHashes);
    }
    return record.updatedAt;
  }

  private flush(): Promise<void> {
    this.clearTimers();
    if (this.disposed || this.flushQueued) return this.queueTail;
    this.flushQueued = true;
    return this.runQueued(async () => {
      this.flushQueued = false;
      await this.runFlush();
    });
  }

  private async runFlush(): Promise<void> {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    try {
      const doc = this.opts.getDoc();
      this.emit({ kind: "local-saving" });
      const at = await this.persistRecovery(doc);
      this.emit({ kind: "local-saved", at });

      if (this.writebackEnabled) {
        this.emit({ kind: "file-writing" });
        const res = await writeBackFile(this.opts.getWritebackDoc?.() ?? doc);
        if (res.ok) {
          if (res.payloadHash) await this.anchorToFile(res.payloadHash);
          this.emit({ kind: "file-saved", at });
        } else {
          this.emit({ kind: "file-unavailable", reason: res.reason ?? "unknown" });
        }
      }
    } catch (e) {
      this.emit({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.flushing = false;
    }
  }

  /**
   * If the recovery snapshot holds content the file does not, return the
   * rehydrated snapshot so the caller can *offer* it. Never applies it: the file
   * stays the source of truth, and a silent swap would hide edits made to the
   * file by anything other than this app.
   *
   * Comparison is by content hash, not by `updatedAt`: every autosave flush
   * stamps a fresh timestamp, so a timestamp test reports "newer" even when the
   * two documents are byte-identical.
   */
  /**
   * Rehydrate a stored snapshot into a live document. Runs the same normalization
   * the file loader does: a snapshot may predate a format change, and a version
   * that renders differently from the file it was taken out of is worse than no
   * version at all.
   */
  private async rehydrate(snapshot: SnapshotDoc): Promise<DesignDocument> {
    const withAssets = await fromSnapshotAssets(snapshot, this.opts.assets);
    return normalizeDesignDocument(withAssets, { preserveUnknown: true }).document;
  }

  /**
   * The comment block the pending snapshot carries, if it carries one.
   *
   * Read separately from `checkRecovery` because the two are restored by the
   * same user decision but stored by different parts of the file: the document
   * is the payload, comments are a conversation beside it. A snapshot written by
   * a build without comments simply has none.
   */
  async recoveryComments(): Promise<unknown> {
    const { docKey } = await this.ensureIdentity();
    const rec = await this.opts.recovery.load(docKey);
    return rec?.comments;
  }

  async checkRecovery(loadedDoc: DesignDocument): Promise<DesignDocument | undefined> {
    const { docKey } = await this.ensureIdentity();
    const rec = await this.opts.recovery.load(docKey);
    if (!rec) return undefined;
    const restored = await this.rehydrate(rec.doc);
    // A snapshot whose bitmaps no longer resolve is worse than no snapshot:
    // adopting it blanks every image layer, and because the placeholders are
    // then re-saved, the damage outlives the reload — the file would be gone for
    // good. The file we were handed still has the artwork, so keep it and let
    // the next flush rewrite a clean record.
    if (hasMissingAssets(restored) && !hasMissingAssets(loadedDoc)) return undefined;
    if (computeContentHash(restored) === computeContentHash(loadedDoc)) return undefined;
    return restored;
  }

  /** Drop the pending recovery snapshot (the user kept the file's version). */
  async discardRecovery(): Promise<void> {    const { docKey } = await this.ensureIdentity();
    // Release what the *stored* record holds. This runs in a fresh session
    // before any flush, so a field tracking "the last set we wrote" is empty
    // here and would leave the snapshot's bitmaps claimed forever.
    const rec = await this.opts.recovery.load(docKey);
    if (rec?.assetHashes) await this.opts.assets.release(rec.assetHashes);
    await this.opts.recovery.clear(docKey);
  }

  // ---- P2: version timeline ----

  private scheduleVersion(): void {
    if (this.disposed || !this.timeline) return;
    if (this.versionTimer) clearTimeout(this.versionTimer);
    this.versionTimer = setTimeout(() => void this.commitVersion(), 800);
  }

  /**
   * The kind the next debounced record takes.
   *
   * A restore arms the version timer through the apply it performs, so the
   * record that lands 800ms later IS the restored state. Claiming the kind here
   * rather than committing a second row leaves one document state with one
   * version, and `restored` is outside the merge window's reach: folding the
   * restored state back into the version it came from would undo the restore in
   * the only place it is recorded.
   */
  private takeRestoreKind(): VersionKind {
    if (!this.pendingRestoreKind) return "auto";
    this.pendingRestoreKind = false;
    return "restored";
  }

  async commitVersion(opts?: { label?: string; named?: boolean; kind?: VersionKind }): Promise<void> {
    if (!this.timeline) return;
    try {
      const { docKey, forkId } = await this.ensureIdentity();
      const kind: VersionKind = opts?.kind ?? (opts?.named ? "named" : this.takeRestoreKind());
      const named = kind === "named";
      const versions = await this.timeline.list(docKey);
      const last = versions[0];
      const now = new Date();
      // Throttle, never overwrite: a version the panel has already shown must
      // keep the content it was born with, or restoring it restores the merge
      // moment instead of the moment it names (styles added and removed inside
      // one merge window became unrestorable). The recovery snapshot still
      // tracks the live state between throttled versions.
      const groupStart = last ? Date.parse(last.groupStartedAt ?? last.createdAt) : 0;
      if (
        kind === "auto" &&
        last &&
        last.kind === "auto" &&
        now.getTime() - groupStart < this.mergeWindowMs
      ) {
        return;
      }
      const doc = this.opts.getDoc();
      const { doc: snapDoc, hashes } = await toSnapshotAssets(doc, this.opts.assets);
      // Seeded from the clock and padded so lexicographic order matches
      // chronological order even when two commits share a millisecond.
      const id = `${docKey}#${(this.versionSeq++).toString(36).padStart(8, "0")}`;
      const rec: VersionRecord = {
        id,
        docKey,
        forkId,
        fileId: this.opts.fileId(),
        label: opts?.label,
        kind,
        named,
        createdAt: now.toISOString(),
        groupStartedAt: now.toISOString(),
        doc: snapDoc,
        assetHashes: hashes,
        sizeBytes: 0,
        docVersion: doc.version,
        appVersion: APP_VERSION
      };
      rec.sizeBytes = estimateSize(rec);
      await this.opts.assets.acquire(hashes);
      await this.timeline.put(rec);
      await applyRetention(this.timeline, this.opts.assets, docKey, this.policy);
      await this.notifyTimeline(docKey);
    } catch (e) {
      this.emit({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Reclaim everything left behind by forks this file has abandoned.
   *
   * A fork fires whenever the file's content is changed by something other than
   * this app, and its rows are keyed by the new fork — so the previous fork's
   * recovery snapshot and versions stay in the store forever, unreachable from
   * the UI and invisible to retention (which only ever looks at the current
   * key). Their assets stay ref-counted too, so the bitmaps are never freed.
   *
   * Named versions are the exception: they are carried onto the current fork
   * rather than deleted. They are a deliberate act by the user, and the promise
   * is that they are never auto-pruned (`applyRetention`) — deleting them here
   * broke that promise silently on every fork.
   *
   * Forks are named `<fileId>#<hash>`, so the family is recoverable by prefix.
   * Call once at boot, after `ready()`.
   */
  async reclaimAbandonedForks(): Promise<number> {
    const { docKey, forkId } = await this.ensureIdentity();
    // Matched against the fileId, not the forkId: once the current fork is
    // `<fileId>#<hash>`, keying on it would no longer recognise the original
    // `<fileId>` fork, which is exactly the row that needs reclaiming.
    const fileId = this.opts.fileId();
    const belongsToFile = (key: string) => key === fileId || key.startsWith(`${fileId}#`);
    let removed = 0;

    for (const rec of await this.opts.recovery.all()) {
      if (rec.docKey === docKey) continue;
      if (!belongsToFile(rec.docKey)) continue;
      if (rec.assetHashes) await this.opts.assets.release(rec.assetHashes);
      await this.opts.recovery.clear(rec.docKey);
      removed++;
    }

    if (this.timeline) {
      for (const v of await this.timeline.all()) {
        if (v.docKey === docKey) continue;
        if (!belongsToFile(v.docKey)) continue;
        if (v.named) {
          // Re-keyed, not released: the version still owns its assets.
          await this.timeline.put({ ...v, docKey, forkId });
          continue;
        }
        await this.timeline.delete(v.id);
        await this.opts.assets.release(v.assetHashes);
        removed++;
      }
    }
    return removed;
  }

  async listVersions(): Promise<VersionSummary[]> {
    if (!this.timeline) return [];
    const { docKey } = await this.ensureIdentity();
    const versions = await this.timeline.list(docKey);
    return versions.map(toSummary);
  }

  /**
   * Restore a version: snapshot the state being left behind, then apply the
   * version. Reports whether the document actually changed — a version whose
   * images are gone bails out, and the caller leaves history mode only for the
   * real thing.
   */
  async restoreVersion(id: string): Promise<boolean> {
    if (!this.timeline || !this.opts.applyDoc) return false;
    const rec = await this.timeline.get(id);
    if (!rec) return false;
    const restored = await this.rehydrate(rec.doc);
    // Same hazard as `checkRecovery`: applying a version whose bitmaps are gone
    // would blank the live document's image layers and then re-save them.
    if (hasMissingAssets(restored)) {
      this.emit({ kind: "error", message: t("history.missingImages") });
      return false;
    }
    // Snapshot the current state first so the restore is itself reversible. It
    // is deliberately NOT an `auto` record: the merge window would collapse it
    // into the previous version, destroying the history the user restores from.
    await this.commitVersion({ label: t("history.beforeRestore"), kind: "pre-restore" });
    // Before the apply, which notifies history synchronously and arms the very
    // record this flag then names.
    this.pendingRestoreKind = true;
    this.opts.applyDoc(restored);
    return true;
  }

  /**
   * The document a version held, read without restoring it.
   *
   * No pre-restore record and no `applyDoc`: browsing versions has to leave the
   * timeline and the live document exactly as they were, which is what lets the
   * history panel open, click, leave again — and mint nothing.
   */
  async previewVersion(id: string): Promise<DesignDocument | null> {
    if (!this.timeline) return null;
    const rec = await this.timeline.get(id);
    if (!rec) return null;
    const doc = await this.rehydrate(rec.doc);
    // Same guard as `restoreVersion`: a version whose bitmaps are gone would
    // paint blank layers, and a *view* has no undo to recover with.
    if (hasMissingAssets(doc)) {
      this.emit({ kind: "error", message: t("history.missingImages") });
      return null;
    }
    return doc;
  }

  async nameVersion(id: string, label: string): Promise<void> {
    if (!this.timeline) return;
    const rec = await this.timeline.get(id);
    if (!rec) return;
    await this.timeline.put({ ...rec, kind: "named", named: true, label });
    await this.notifyTimeline(rec.docKey);
  }

  async deleteVersion(id: string): Promise<void> {
    if (!this.timeline) return;
    const rec = await this.timeline.get(id);
    if (!rec || rec.named) return;
    await this.timeline.delete(id);
    await this.opts.assets.release(rec.assetHashes);
    await this.notifyTimeline(rec.docKey);
  }

  async exportVersion(id: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.timeline) return { ok: false, reason: "no-timeline" };
    const rec = await this.timeline.get(id);
    if (!rec) return { ok: false, reason: "not-found" };
    const doc = await this.rehydrate(rec.doc);
    const name = rec.label ? `${rec.label}.fish.html` : `version-${rec.createdAt.slice(0, 10)}.fish.html`;
    return saveDocAsNewFile(doc, name, undefined, { freshFileId: true });
  }

  private async notifyTimeline(docKey: string): Promise<void> {
    if (!this.opts.onTimeline) return;
    const versions = await this.timeline?.list(docKey);
    if (!versions) return;
    this.opts.onTimeline(versions.map(toSummary));
  }
}

function toSummary(v: VersionRecord): VersionSummary {
  return {
    id: v.id,
    createdAt: v.createdAt,
    label: v.label,
    kind: v.kind,
    named: v.named,
    sizeBytes: v.sizeBytes
  };
}

/**
 * Whether two snapshot asset lists hold the same hashes, multiplicities
 * included: one hash appears once per ref that points at it, and a document
 * that names one bitmap three times acquires it three times.
 */
function sameHashSet(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sorted = [...b].sort();
  const prev = [...a].sort();
  for (let i = 0; i < sorted.length; i++) if (prev[i] !== sorted[i]) return false;
  return true;
}

export type { WritebackPermission };

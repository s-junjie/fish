import type { DesignDocument, Page } from "../dsl/types";
import { normalizeDesignDocument } from "../dsl/normalize";
import type { KVBackend } from "./backend";
import type { SnapshotDoc } from "./assets";
import { stableHash, cachedHash, objectHash } from "./hash";

export interface RecoveryRecord {
  key: string;
  docKey: string;
  /** Identity of the file, not of the document — survives a corrupt doc block. */
  fileId: string;
  forkId: string;
  updatedAt: string;
  // Stored form: assets are replaced by content hashes (see toSnapshotAssets).
  doc: SnapshotDoc;
  /** The content hashes this snapshot owns (for asset ref-counting). */
  assetHashes?: string[];
  /** Format and application versions this snapshot was written with. */
  docVersion?: string;
  appVersion?: string;
  /**
   * The `#fish-comments` block as it stood at the snapshot.
   *
   * Untyped on purpose: this layer stores bytes, and the comment model is the
   * comment module's business. Without it a comment written between two saves
   * exists only in memory until the file is written — the document recovers
   * after a crash and the conversation does not.
   */
  comments?: unknown;
}

interface MetaRow {
  key: string;
  fileId: string;
  forkId: string;
  docKey: string;
  /**
   * `computePayloadHash` of the file we last read or wrote — NOT of the document
   * we happen to be holding. In-app edits change our doc while the file on disk
   * stays put, so anchoring on the live doc would open a new fork on every
   * reload and scatter the entire history. Anchored on the file, a fork fires
   * only when the file was changed by something other than this app.
   */
  fileContentHash: string;
}

export interface RecoveryStore {
  save(record: RecoveryRecord): Promise<void>;
  load(docKey: string): Promise<RecoveryRecord | undefined>;
  meta(fileId: string): Promise<MetaRow | undefined>;
  saveMeta(fileId: string, forkId: string, docKey: string, fileContentHash: string): Promise<void>;
  setFileContentHash(fileId: string, hash: string): Promise<void>;
  clear(docKey: string): Promise<void>;
  /** Every record, so abandoned forks can be found and reclaimed. */
  all(): Promise<RecoveryRecord[]>;
}

class KVRecoveryStore implements RecoveryStore {
  constructor(private backend: KVBackend) {}

  save(record: RecoveryRecord): Promise<void> {
    return this.backend.put("recovery", record);
  }

  load(docKey: string): Promise<RecoveryRecord | undefined> {
    return this.backend.get("recovery", docKey) as Promise<RecoveryRecord | undefined>;
  }

  meta(fileId: string): Promise<MetaRow | undefined> {
    return this.backend.get("meta", fileId) as Promise<MetaRow | undefined>;
  }

  async saveMeta(fileId: string, forkId: string, docKey: string, fileContentHash: string): Promise<void> {
    await this.backend.put("meta", {
      key: fileId,
      fileId,
      forkId,
      docKey,
      fileContentHash
    } as MetaRow);
  }

  async setFileContentHash(fileId: string, hash: string): Promise<void> {
    const existing = await this.meta(fileId);
    if (!existing) return;
    await this.backend.put("meta", { ...existing, fileContentHash: hash } as MetaRow);
  }

  all(): Promise<RecoveryRecord[]> {
    return this.backend.getAll("recovery") as Promise<RecoveryRecord[]>;
  }

  clear(docKey: string): Promise<void> {
    return this.backend.delete("recovery", docKey);
  }
}

export function createRecoveryStore(backend: KVBackend): RecoveryStore {
  return new KVRecoveryStore(backend);
}
/**
 * A page minus the view the editor was left on.
 *
 * `metadata.viewport` is where the camera sits, not what the document says, and
 * a save stamps it into the file. A hash that counted it would call a file
 * different from its own recovery snapshot after nothing but a pan, and offer to
 * "recover" work that was never lost.
 *
 * An emptied `metadata` is dropped rather than left as `{}`: the normalizer only
 * writes the key when there is something to hold, so the two spellings would
 * hash differently for one page.
 */
function withoutViewport(page: Page): Page {
  const metadata = page.metadata;
  if (!metadata || metadata.viewport === undefined) return page;
  const { viewport: _camera, ...rest } = metadata;
  const stripped: Page = { ...page };
  if (Object.keys(rest).length > 0) stripped.metadata = rest;
  else delete stripped.metadata;
  return stripped;
}

/**
 * Identity hash of the document *content* (ignores volatile `updatedAt` and the
 * remembered viewport). Two copies of the same file share a hash; an edited copy
 * diverges.
 *
 * Hashed in PARTS rather than as one string: a document carries its bitmaps
 * inline, so the canonical form of the measured file is 42.6 MB and one
 * `stableHash` over it blocked the main thread for 226 ms — on every autosave,
 * every dirty check and even `beforeunload`. Pages and asset URIs are hashed
 * individually by `cachedHash` (each image is the same string across commits)
 * and only the digests are folded together.
 *
 * The value differs from the one-string form an earlier build produced. Nothing
 * persisted depends on it: the fork anchor is the file's payload hash
 * (`computePayloadHash`), and this only stands in when a caller has no file
 * text, in which case a rebuild re-anchors the fork once rather than reading a
 * foreign edit into our history.
 *
 * Memoized per document OBJECT for the same reason every index in the codebase
 * is: a commit replaces the document, so a hash cannot outlive the content it
 * describes. One save asks for this hash three times — dirty check, write,
 * re-anchor — and normalizing a 42.6 MB document is most of the remaining cost.
 */
const hashMemo = new WeakMap<DesignDocument, string>();

export function computeContentHash(doc: DesignDocument): string {
  const memo = hashMemo.get(doc);
  if (memo !== undefined) return memo;
  // Normalized first, so the hash describes the *document* rather than the
  // spelling it happens to be written in. Without it the file on disk
  // (normalized on the way out) and the live document hash differently for
  // identical content, and the identity check would refuse the user's own file.
  const canonicalDoc = normalizeDesignDocument(doc, { preserveUnknown: true }).document;
  const parts: string[] = [
    canonicalDoc.version ?? "",
    canonicalDoc.id ?? "",
    canonicalDoc.name ?? "",
    JSON.stringify(canonicalDoc.canvas ?? null)
  ];
  for (const page of canonicalDoc.pages) parts.push(cachedHash(JSON.stringify(withoutViewport(page))));
  // Normalization builds fresh asset objects on every call, so the canonical
  // copy is useless as a cache key: a 5 MB bitmap would be re-hashed by every
  // save. The live ref is the identity that survives; it is only used as a key,
  // and only when it demonstrably carries the very string being hashed, so the
  // digest is the one `cachedHash` would have produced either way.
  const liveAssets = (doc.assets ?? []) as { uri?: string }[];
  for (const [i, a] of (canonicalDoc.assets ?? []).entries()) {
    const uri = (a as { uri?: string }).uri ?? "";
    const live = liveAssets[i];
    parts.push(live && (live.uri ?? "") === uri ? objectHash(live, uri) : cachedHash(uri));
  }
  const hash = stableHash(parts.join("\u0001"));
  hashMemo.set(doc, hash);
  return hash;
}

/**
 * Identity hash of the file's own payload — the text the `#design-doc` block
 * holds, trimmed.
 *
 * This is what the fork anchor is documented to hold, and it is the only value
 * that can. `computeContentHash` normalizes and migrates first, so any change to
 * the normalizer or the layout engine changes the hash of a file nobody touched:
 * every existing document forked on the next open, and `reclaimAbandonedForks`
 * then destroyed the previous fork's history. The payload text only moves when
 * something outside this app rewrites the file.
 */
export function computePayloadHash(payloadText: string): string {
  return stableHash(payloadText.trim());
}

export interface ForkResolution {
  forkId: string;
  docKey: string;
  fileContentHash: string;
  forked: boolean;
}

/**
 * Decide which fork a document belongs to under a given `docId`.
 *
 * **Call once per session, at load.** It answers "is the file I just opened the
 * same lineage as the one I recorded?" — a question about the file, not about
 * the document the user is editing. Calling it again after an edit would always
 * see a different hash and fork, which strands the history on a fresh key every
 * time the document changes.
 *
 * `payloadHash` is the file's own text hash (`computePayloadHash`); pass it
 * whenever the caller has the file. Without it the anchor falls back to
 * `computeContentHash`, which makes the identity a property of the engine
 * instead of the file — see `computePayloadHash`.
 *
 * - No prior record: first-seen incarnation; its hash becomes the anchor.
 * - Hash matches the anchor: same lineage, keep the existing fork.
 * - Hash differs: the file was changed by something other than this app (an
 *   external editor, an agent, or an independent copy). Open a new fork so its
 *   history never merges into ours.
 */
export async function resolveFork(
  fileId: string,
  doc: DesignDocument,
  store: RecoveryStore,
  payloadHash?: string
): Promise<ForkResolution> {
  const hash = payloadHash ?? computeContentHash(doc);
  const existing = await store.meta(fileId);
  if (!existing) {
    await store.saveMeta(fileId, fileId, fileId, hash);
    return { forkId: fileId, docKey: fileId, fileContentHash: hash, forked: false };
  }
  if (existing.fileContentHash === hash) {
    return {
      forkId: existing.forkId,
      docKey: existing.docKey,
      fileContentHash: hash,
      forked: false
    };
  }
  const forkId = `${fileId}#${hash.slice(0, 8)}`;
  await store.saveMeta(fileId, forkId, forkId, hash);
  return { forkId, docKey: forkId, fileContentHash: hash, forked: true };
}

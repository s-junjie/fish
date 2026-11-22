import type { DesignDocument, Page } from "../dsl/types";
import { normalizeDesignDocument } from "../dsl/normalize";
import type { KVBackend } from "./backend";
import type { SnapshotDoc } from "./assets";
import { stableHash, cachedHash, objectHash } from "./hash";
import { foldHtmlSources } from "../document-json";

export interface RecoveryRecord {
  key: string;
  docKey: string;
  /** Identity of the file, not of the document — survives a corrupt doc block. */
  fileId: string;
  forkId: string;
  updatedAt: string;
  // Stored form: bitmaps and html srcdoc are replaced by content hashes (see toSnapshotAssets).
  doc: SnapshotDoc;
  /** The content hashes this snapshot owns (for asset ref-counting). */
  assetHashes?: string[];
  /** Format and application versions this snapshot was written with. */
  docVersion?: string;
  appVersion?: string;
  comments?: unknown;
}

interface MetaRow {
  key: string;
  fileId: string;
  forkId: string;
  docKey: string;
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
  constructor(private backend: KVBackend) { }

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

function withoutViewport(page: Page): Page {
  const metadata = page.metadata;
  if (!metadata || metadata.viewport === undefined) return page;
  const { viewport: _camera, ...rest } = metadata;
  const stripped: Page = { ...page };
  if (Object.keys(rest).length > 0) stripped.metadata = rest;
  else delete stripped.metadata;
  return stripped;
}

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
  // A literal `srcdoc` and a `fish-html:` reference describe the same document;
  // folding both to the reference keeps a format change from reading as a content
  // change and offering to "recover" a file that was only re-saved.
  const folded = foldHtmlSources(canonicalDoc as unknown as Record<string, unknown>);
  const pages = (Array.isArray(folded.pages) ? folded.pages : canonicalDoc.pages) as Page[];
  for (const page of pages) parts.push(cachedHash(JSON.stringify(withoutViewport(page))));
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

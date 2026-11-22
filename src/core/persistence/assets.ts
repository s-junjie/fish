import type { AssetRef, DesignDocument, DesignElement, HtmlEmbedElement, HtmlSource, Page } from "../dsl/types";
import { flattenElements, mapElements } from "../geometry/tree-edit";
import { HTML_REF_PREFIX } from "../interactions/html-embed-loader";
import type { KVBackend } from "./backend";
import { objectHash } from "./hash";

/**
 * A document as it is stored in a snapshot: inline bitmaps are replaced by their
 * content hashes, and an html embed's `srcdoc` by a locator to its own row.
 * Spelled out rather than cast, because a cast here means `assets` looks like
 * `AssetRef[]` while actually holding strings — and anything that runs such a
 * document through normalization would drop every asset without a word.
 *
 * `pages` is restated because `DesignDocument` has an index signature: `Omit`
 * over `keyof` = `string` erases every named member, leaving only `unknown`.
 */
export type SnapshotDoc = Omit<DesignDocument, "assets"> & { assets?: string[]; pages: Page[] };

/** Distinguishes a stored reference from a legacy snapshot's literal HTML. */
export const SRCDOC_REF_PREFIX = "fish-srcdoc:";

type WithPages = { pages: Page[] };

// A recovery record can predate `pages`; normalization runs after rehydration,
// so neither traversal may assume the shape is current.
function htmlEmbeds(doc: WithPages): HtmlEmbedElement[] {
  if (!Array.isArray(doc.pages)) return [];
  return doc.pages.flatMap((page) =>
    flattenElements(Array.isArray(page?.children) ? page.children : []).filter(
      (el): el is HtmlEmbedElement => el.type === "html"
    )
  );
}

function mapSrcdocs<T extends WithPages>(doc: T, fn: (html: string) => string): T {
  if (!Array.isArray(doc.pages)) return doc;
  let changed = false;
  const pages = doc.pages.map((page) => {
    if (!Array.isArray(page?.children)) return page;
    const children = mapElements(page.children, (el: DesignElement) => {
      if (el.type !== "html") return el;
      const html = (el as HtmlEmbedElement).srcdoc;
      if (typeof html !== "string" || !html) return el;
      const next = fn(html);
      if (next === html) return el;
      changed = true;
      return { ...el, srcdoc: next } as DesignElement;
    });
    return children === page.children ? page : { ...page, children };
  });
  return changed ? { ...doc, pages } : doc;
}

/**
 * A stable ref shape keeps `sameStoredRef` true across embeds and across saves:
 * two layers carrying the same page must resolve to one row, not rewrite 8 MB
 * under an id that changes with the layer.
 */
function srcdocRef(html: string): AssetRef {
  return { id: "srcdoc", name: "HTML embed", uri: html };
}

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
  // difference between an idle save and 42 ms of blocked main thread. Keyed by
  // the ref rather than by the string, because the string is the bitmap.
  return "a" + objectHash(ref, ref.uri || ref.id || "");
}

interface AssetRow {
  key: string;
  ref: AssetRef;
  refCount: number;
}

/**
 * What this session remembers about a row it has already read or written.
 *
 * `refCount` is the only field that has to live here: it is what `acquire` and
 * `release` move, and re-reading it per hash per save is the cost this map
 * exists to remove. The ref rides along weakly, because a row outlives the
 * document that owns its bitmap — worth having while the document is open (a
 * `put` of an equal ref can then prove itself without touching IndexedDB), and
 * worth nothing once it is closed, which is exactly when a strong reference
 * here would keep every image of the session in the heap.
 */
interface ResidentRow {
  refCount: number;
  ref: WeakRef<AssetRef>;
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
  private resident = new Map<string, ResidentRow | null>();

  constructor(private backend: KVBackend) {}

  private async known(hash: string): Promise<AssetRow | undefined> {
    const cached = this.resident.get(hash);
    if (cached === null) return undefined;
    if (cached) {
      const ref = cached.ref.deref();
      if (ref) return { key: hash, ref, refCount: cached.refCount };
      // The count is still this session's answer; only the bytes have to come
      // back from the store, because the object that carried them is gone.
    }
    const row = (await this.backend.get("assets", hash)) as AssetRow | undefined;
    this.remember(hash, row);
    return row;
  }

  private remember(hash: string, row: AssetRow | undefined): void {
    this.resident.set(hash, row ? { refCount: row.refCount, ref: new WeakRef(row.ref) } : null);
  }

  private async write(hash: string, row: AssetRow): Promise<void> {
    this.remember(hash, row);
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

  /**
   * Write every changed row in one transaction.
   *
   * A snapshot names 107 bitmaps, and a row carries its whole bitmap: one
   * transaction per hash meant 107 of them — and 107 round trips — to move the
   * same set of refcounts. The backend is asked to batch; a backend that cannot
   * still gets the same writes, one at a time.
   */
  private async flush(puts: AssetRow[], deletes: string[]): Promise<void> {
    if (puts.length === 0 && deletes.length === 0) return;
    if (this.backend.putMany && this.backend.deleteMany) {
      await this.backend.putMany("assets", puts);
      await this.backend.deleteMany("assets", deletes);
      return;
    }
    for (const row of puts) await this.backend.put("assets", row);
    for (const key of deletes) await this.backend.delete("assets", key);
  }

  async acquire(hashes: string[]): Promise<void> {
    const rows = new Map<string, AssetRow>();
    for (const hash of hashes) {
      const existing = rows.get(hash) ?? (await this.known(hash));
      if (!existing) continue;
      const row = { ...existing, refCount: existing.refCount + 1 };
      rows.set(hash, row);
      this.remember(hash, row);
    }
    await this.flush([...rows.values()], []);
  }

  async release(hashes: string[]): Promise<void> {
    const rows = new Map<string, AssetRow>();
    const deleted = new Set<string>();
    for (const hash of hashes) {
      if (deleted.has(hash)) continue;
      const existing = rows.get(hash) ?? (await this.known(hash));
      if (!existing) continue;
      const next = existing.refCount - 1;
      if (next <= 0) {
        rows.delete(hash);
        deleted.add(hash);
        this.resident.delete(hash);
      } else {
        const row = { ...existing, refCount: next };
        rows.set(hash, row);
        this.remember(hash, row);
      }
    }
    await this.flush([...rows.values()], [...deleted]);
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
 * Replace a document's inline bitmaps and `srcdoc` documents with content
 * hashes. Both are bulky strings that a snapshot would otherwise copy verbatim
 * for every version; here they live once in the asset store. `put` is idempotent
 * and does NOT claim ownership — callers that persist a snapshot must `acquire`
 * the returned hashes and `release` them on discard.
 */
export async function toSnapshotAssets(
  doc: DesignDocument,
  assets: AssetStore
): Promise<{ doc: SnapshotDoc; hashes: string[] }> {
  const bitmapHashes: string[] = [];
  for (const ref of doc.assets ?? []) bitmapHashes.push(await assets.put(ref));

  const docs = new Map<string, string>();
  const srcdocHashes: string[] = [];
  for (const el of htmlEmbeds(doc)) {
    const html = el.srcdoc;
    if (!html || html.startsWith(HTML_REF_PREFIX)) continue;
    // A locator already on the live document is an unresolved restore: claim its
    // row so the next rehydrate can still find the page behind it.
    if (html.startsWith(SRCDOC_REF_PREFIX)) {
      srcdocHashes.push(html.slice(SRCDOC_REF_PREFIX.length));
      continue;
    }
    let hash = docs.get(html);
    if (!hash) {
      hash = await assets.put(srcdocRef(html));
      docs.set(html, hash);
    }
    srcdocHashes.push(hash);
  }

  const sourceTable: Record<string, HtmlSource> = {};
  const sourceHashes: string[] = [];
  for (const [key, source] of Object.entries(doc.htmlSources ?? {})) {
    const text = source?.text;
    if (typeof text !== "string" || !text) {
      sourceTable[key] = source;
      continue;
    }
    if (text.startsWith(SRCDOC_REF_PREFIX)) {
      sourceHashes.push(text.slice(SRCDOC_REF_PREFIX.length));
      sourceTable[key] = source;
      continue;
    }
    let hash = docs.get(text);
    if (!hash) {
      hash = await assets.put(srcdocRef(text));
      docs.set(text, hash);
    }
    sourceHashes.push(hash);
    sourceTable[key] = { ...source, text: SRCDOC_REF_PREFIX + hash };
  }

  const stripped = mapSrcdocs(doc, (html) => {
    const hash = docs.get(html);
    return hash ? SRCDOC_REF_PREFIX + hash : html;
  });
  const hashes = [...bitmapHashes, ...srcdocHashes, ...sourceHashes];
  return {
    doc: {
      ...stripped,
      assets: bitmapHashes,
      ...(Object.keys(sourceTable).length > 0 ? { htmlSources: sourceTable } : {})
    },
    hashes
  };
}

/**
 * Inverse of {@link toSnapshotAssets}. A legacy snapshot whose `srcdoc` is
 * literal HTML has no locator and is passed through untouched, so histories
 * written before this change still restore.
 */
export async function fromSnapshotAssets(
  doc: SnapshotDoc,
  assets: AssetStore
): Promise<DesignDocument> {
  const bitmapHashes = doc.assets ?? [];
  const sourceEntries = Object.entries(doc.htmlSources ?? {});
  const locatorHashes = [
    ...new Set(
      [
        ...htmlEmbeds(doc).map((el) => el.srcdoc),
        ...sourceEntries.map(([, source]) => source?.text)
      ]
        .filter((s): s is string => typeof s === "string" && s.startsWith(SRCDOC_REF_PREFIX))
        .map((s) => s.slice(SRCDOC_REF_PREFIX.length))
    )
  ];
  const resolved = await assets.getMany([...bitmapHashes, ...locatorHashes]);
  const restored: AssetRef[] = resolved
    .slice(0, bitmapHashes.length)
    .map((r, i) => r ?? { id: `missing_${i}`, name: "Missing asset", uri: "" });

  const docs = new Map<string, string>();
  locatorHashes.forEach((hash, i) => {
    const uri = resolved[bitmapHashes.length + i]?.uri;
    if (uri !== undefined) docs.set(hash, uri);
  });
  // An unresolved locator is kept rather than turned into an empty page, so the
  // missing-resource guard below can refuse the restore instead of saving a
  // reference string back into the document as if it were HTML.
  const withDocs = mapSrcdocs(doc, (html) =>
    html.startsWith(SRCDOC_REF_PREFIX)
      ? (docs.get(html.slice(SRCDOC_REF_PREFIX.length)) ?? html)
      : html
  );
  const htmlSources = sourceEntries.length
    ? Object.fromEntries(
        sourceEntries.map(([key, source]) => {
          const text = source?.text;
          const value =
            typeof text === "string" && text.startsWith(SRCDOC_REF_PREFIX)
              ? (docs.get(text.slice(SRCDOC_REF_PREFIX.length)) ?? text)
              : text;
          return [key, { ...source, text: value ?? "" }];
        })
      )
    : undefined;
  // The cast is the Omit in `SnapshotDoc` losing the rest of the shape on spread.
  return {
    ...withDocs,
    assets: restored,
    ...(htmlSources ? { htmlSources } : {})
  } as unknown as DesignDocument;
}

/**
 * True when a rehydrated snapshot still carries placeholder refs or unresolved
 * `srcdoc` locators, i.e. rows the asset store no longer holds. Such a document
 * would paint blank images or an empty frame, so history refuses to preview or
 * restore it.
 */
export function hasMissingAssets(doc: DesignDocument): boolean {
  if ((doc.assets ?? []).some((a) => !a.uri)) return true;
  if (Object.values(doc.htmlSources ?? {}).some((s) => s?.text?.startsWith(SRCDOC_REF_PREFIX))) return true;
  return htmlEmbeds(doc).some((el) => el.srcdoc?.startsWith(SRCDOC_REF_PREFIX));
}

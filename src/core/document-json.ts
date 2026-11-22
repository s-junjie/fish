import type { DesignDocument } from "./dsl/types";
import { adoptTopLevelElements } from "./dsl/document-ops";
import { normalizeDesignDocument } from "./dsl/normalize";
import type { NormalizationRepair } from "./dsl/normalize/shared";
import { applyCssSpelling } from "./dsl/css-spelling";
import { syncDocumentBindings } from "./interactions/style-ops";
import { HTML_REF_PREFIX, htmlSourceKey, isHtmlSourceRef } from "./interactions/html-embed-loader";

/**
 * Document-level JSON — the ONE place a document becomes text.
 *
 * There are five readers of this text (the `.fish.html` block, the `.fish.json`
 * export, the clipboard, and two CLI subcommands), and they used to be five
 * hand-written `JSON.stringify` calls. They differ in exactly two respects, so
 * those are the two parameters and nothing else is duplicated:
 *
 *   pretty  — a human reading a diff, or a machine carrying a payload
 *   assets  — bitmaps inline, or lifted into their own `#fish-assets` block
 *
 * "Compact" is not a projection and not an elision — it is the SAME document,
 * cheaper to carry. That constraint is what makes it usable: the contract given
 * to every external author is "edit this JSON, hand it back" (see
 * `agent-kit/references/workflow.md` §2), so a compact form that dropped
 * something a replace could not restore would break the loop it exists to feed.
 * The image bitmaps in `assets` are 60% of a real document's bytes and stay in
 * unless the caller asked for the shell's split form.
 */

export interface DocumentTextOptions {
  pretty: boolean;
  /** `external` lifts `assets[].uri` into `assetUris` (the `.fish.html` block). */
  assets?: "inline" | "external";
  /**
   * What the canonicalisation pass dropped on the way to text.
   *
   * This is the only moment the drop is visible: the text below is already the
   * repaired document, so whatever reads it back has nothing left to complain
   * about. A writer that can tell its caller (`compose`, `apply`) passes this and
   * turns a non-`info` repair into a failed command; one that cannot (a save in
   * the app) loses nothing it did not already lose.
   */
  onRepair?: (repair: NormalizationRepair) => void;
}

export interface DocumentText {
  /** The text to write or return. Callers that embed it in HTML still escape. */
  json: string;
  /** Non-empty only for `assets: "external"`. */
  assetUris: Record<string, string>;
}

/**
 * A live document as a plain object, in the canonical shape every reader agrees
 * on. This is layer ① — the only `doc` → object conversion.
 */
export function documentToPlainObject(
  doc: DesignDocument,
  onRepair?: (repair: NormalizationRepair) => void
): Record<string, unknown> {
  const plain = applyCssSpelling(canonicalDocument(doc, onRepair) as unknown as Record<string, unknown>);
  return foldHtmlSources(plain);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The one gate every writer passes through. A literal `srcdoc` can arrive from
 * an older file, a paste from another document, an AI-authored JSON block or the
 * CLI; folding it here means all of them converge on one stored copy instead of
 * needing their own dedup path.
 */
export function foldHtmlSources(plain: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(plain.pages)) return plain;
  const known: Record<string, unknown> = isRecord(plain.htmlSources) ? plain.htmlSources : {};
  // Content-addressed rows are only reachable through a `fish-html:` reference,
  // so the pool is rebuilt from what this document still names: an edit writes a
  // new key, and the abandoned one would otherwise stay in the file — and in
  // every `.fish.html` saved after it — for the rest of the document's life.
  const referenced = new Set<string>();
  const fresh: Record<string, unknown> = {};
  let folded = 0;
  const walk = (nodes: unknown[]): unknown[] =>
    nodes.map((node) => {
      if (!isRecord(node)) return node;
      let out = node;
      if (node.type === "html" && typeof node.srcdoc === "string" && node.srcdoc) {
        if (isHtmlSourceRef(node.srcdoc)) {
          referenced.add(node.srcdoc.slice(HTML_REF_PREFIX.length));
        } else {
          const key = htmlSourceKey(node.srcdoc);
          referenced.add(key);
          if (!(key in fresh)) fresh[key] = { text: node.srcdoc };
          out = { ...node, srcdoc: HTML_REF_PREFIX + key };
          folded += 1;
        }
      }
      if (Array.isArray(out.children)) out = { ...out, children: walk(out.children) };
      return out;
    });
  const pages = plain.pages.map((page) =>
    isRecord(page) && Array.isArray(page.children)
      ? { ...page, children: walk(page.children) }
      : page
  );
  const stale = Object.keys(known).some((key) => !referenced.has(key));
  if (folded === 0 && !stale) return plain;
  // Known rows keep their place so an edit that only drops one row does not
  // reorder the rest of the block in the saved file.
  const sources: Record<string, unknown> = {};
  for (const key of Object.keys(known)) {
    if (referenced.has(key)) sources[key] = known[key];
  }
  for (const key of referenced) {
    if (!(key in sources) && key in fresh) sources[key] = fresh[key];
  }
  return { ...plain, pages, htmlSources: sources };
}

/** Layer ② — the only object → text conversion. */
export function toDocumentText(doc: DesignDocument, opts: DocumentTextOptions): DocumentText {
  const plain = documentToPlainObject(doc, opts.onRepair);
  const { body, assetUris } =
    opts.assets === "external" ? splitAssetUris(plain) : { body: plain, assetUris: {} };
  return { json: JSON.stringify(body, null, opts.pretty ? 2 : undefined), assetUris };
}

/** The full document, pretty-printed, for a `.fish.json` export or a CLI dump. */
export function documentJson(
  doc: DesignDocument,
  onRepair?: (repair: NormalizationRepair) => void
): string {
  return toDocumentText(doc, { pretty: true, assets: "inline", onRepair }).json;
}

/** The same document, minified. */
export function compactDocumentJson(
  doc: DesignDocument,
  onRepair?: (repair: NormalizationRepair) => void
): string {
  return toDocumentText(doc, { pretty: false, assets: "inline", onRepair }).json;
}

/**
 * Run a live document through the reader every stored document went through, so
 * what these produce is exactly what `Replace from JSON` will accept back.
 */
export function canonicalDocument(
  doc: DesignDocument,
  onRepair?: (repair: NormalizationRepair) => void
): DesignDocument {
  // Written out materialised: what the author handed back is a reference, and
  // every reader of this text paints the value beside it, not the id.
  const { document, repairs } = normalizeDesignDocument(adoptTopLevelElements(doc), { preserveUnknown: true });
  for (const repair of repairs) onRepair?.(repair);
  return syncDocumentBindings(document);
}

/**
 * Bitmaps live in their own block for the `.fish.html` shell so the structure
 * stays readable: a single inline image is most of the document's bytes, and
 * base64 barely compresses, so the element tree ends up buried under a wall no
 * diff or grep can see past. The file is still one file — `assetUris` is what
 * the caller writes into `#fish-assets`, and a file that still carries its URIs
 * inline reads fine, so nothing needs migrating.
 */
function splitAssetUris(plain: Record<string, unknown>): {
  body: Record<string, unknown>;
  assetUris: Record<string, string>;
} {
  const assets = plain.assets;
  if (!Array.isArray(assets)) return { body: plain, assetUris: {} };
  const assetUris: Record<string, string> = {};
  const stripped = assets.map((ref) => {
    if (!ref || typeof ref !== "object") return ref;
    const { uri, ...rest } = ref as { uri?: unknown } & Record<string, unknown>;
    if (typeof uri === "string" && uri) assetUris[String((ref as { id?: unknown }).id)] = uri;
    return rest;
  });
  return { body: { ...plain, assets: stripped }, assetUris };
}

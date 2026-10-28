import type { DesignDocument } from "./dsl/types";
import { adoptTopLevelElements } from "./dsl/types";
import { normalizeDesignDocument } from "./dsl/normalize";
import { applyCssSpelling } from "./dsl/css-spelling";
import { syncDocumentBindings } from "./interactions/style-ops";

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
export function documentToPlainObject(doc: DesignDocument): Record<string, unknown> {
  return applyCssSpelling(canonicalDocument(doc) as unknown as Record<string, unknown>);
}

/** Layer ② — the only object → text conversion. */
export function toDocumentText(doc: DesignDocument, opts: DocumentTextOptions): DocumentText {
  const plain = documentToPlainObject(doc);
  const { body, assetUris } =
    opts.assets === "external" ? splitAssetUris(plain) : { body: plain, assetUris: {} };
  return { json: JSON.stringify(body, null, opts.pretty ? 2 : undefined), assetUris };
}

/** The full document, pretty-printed, for a `.fish.json` export or a CLI dump. */
export function documentJson(doc: DesignDocument): string {
  return toDocumentText(doc, { pretty: true, assets: "inline" }).json;
}

/** The same document, minified. */
export function compactDocumentJson(doc: DesignDocument): string {
  return toDocumentText(doc, { pretty: false, assets: "inline" }).json;
}

/**
 * Run a live document through the reader every stored document went through, so
 * what these produce is exactly what `Replace from JSON` will accept back.
 */
export function canonicalDocument(doc: DesignDocument): DesignDocument {
  // Written out materialised: what the author handed back is a reference, and
  // every reader of this text paints the value beside it, not the id.
  return syncDocumentBindings(normalizeDesignDocument(adoptTopLevelElements(doc), { preserveUnknown: true }).document);
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

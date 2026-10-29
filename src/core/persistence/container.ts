import { DesignDocument, AssetRef } from "../dsl/types";
import { normalizeDesignDocument } from "../dsl/normalize";
import { parseLenientJson } from "../dsl/lenient-json";
import { syncDocumentBindings } from "../interactions/style-ops";
import { mintFileId } from "../id";
import { toDocumentText } from "../document-json";
import { insertCoverBlock, stripCoverBlock } from "../cover-block";
import { documentTitleFor, stampDocumentTitle } from "../document-title";
import { computePayloadHash } from "./recovery";
import { FishCommentsDocument } from "../comments/types";
import { getActiveComments, parseCommentsBlock } from "../comments/comments-bridge";
import { readFileIdFromShell } from "./file-identity";
import { getFileName } from "./file-paths";

export const DOC_BLOCK_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;
export const ASSETS_BLOCK_RE = /<script\s+id=["']fish-assets["'][^>]*>([\s\S]*?)<\/script>/i;
export const BOTH_BLOCKS_RE =
  /(<meta\s+name=["']fish:fileId["'][^>]*>\s*)?<script\s+id=["']design-doc["'][^>]*>[\s\S]*?<\/script>((\s*<script\s+id=["']fish-comments["'][^>]*>[\s\S]*?<\/script>)|(\s*<script\s+id=["']fish-assets["'][^>]*>[\s\S]*?<\/script>))*/i;

let pristineHtml = "";

export function getPristineHtml(): string {
  return pristineHtml;
}

export function setPristineHtml(html: string): void {
  pristineHtml = html;
}

/**
 * The shell rebuilds its own `<style>` and `<script>` at boot and marks them
 * `data-fish-transient`. Serialising the live document would paste that unpacked
 * copy — the whole bundle in plaintext — into every saved file, and again on the
 * next save of that file, without bound. The payload blocks in the file itself are
 * not transient and must survive, or the file would lose its runtime.
 */
export function capturePristine(): void {
  if (typeof document === "undefined") return;
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const injected = clone.querySelectorAll("[data-fish-transient]");
  for (let i = 0; i < injected.length; i++) injected[i].remove();
  pristineHtml = clone.outerHTML;
}

/** Put the URIs back, given the parsed `fish-assets` block (if any). */
export function mergeAssets(doc: DesignDocument, uris: Record<string, string>): DesignDocument {
  if (!doc.assets || doc.assets.length === 0) return doc;
  return {
    ...doc,
    assets: doc.assets.map((ref) => {
      const uri = uris[ref.id];
      return uri ? { ...ref, uri } : ref;
    })
  };
}

export function parseAssetsBlock(html: string): Record<string, string> {
  const body = ASSETS_BLOCK_RE.exec(html)?.[1]?.trim();
  if (!body) return {};
  try {
    const parsed = JSON.parse(body.replace(/\\u003c/g, "<"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * The one way a raw document becomes a live one.
 *
 * Every reader goes through it — the file being opened, the file the user picks
 * as a write-back target, a recovered backup — because they have to agree. If
 * one loader normalized and the others did not, the same content would hash
 * differently and the identity check would refuse the user's own file.
 */
export function readDocument(raw: unknown): DesignDocument {
  // Materialised last, so a file that only names its styles still paints them:
  // the renderer reads `el.style` / `el.fills` and never resolves an id.
  return syncDocumentBindings(normalizeDesignDocument(raw, { preserveUnknown: true }).document);
}

/**
 * The design document block of a `.fish.html`, exactly as the file holds it.
 * `undefined` means the file is not a FISH document at all.
 */
export function payloadTextFromHtml(html: string): string | undefined {
  const match = DOC_BLOCK_RE.exec(html);
  if (!match) return undefined;
  return match[1];
}

/**
 * `computePayloadHash` of that block.
 *
 * Empty and unparseable blocks still hash rather than failing: an empty shell is
 * what a freshly built file looks like, and "the file I opened is an empty shell"
 * is a perfectly good baseline to compare against — without it an empty shell had
 * no baseline, the check was skipped, and auto-save could adopt any file in the
 * picker, overwriting one that already had work in it. A block that has been
 * truncated still identifies its file for the same reason the `fileId` stamp
 * does: identity must not depend on being able to read the document.
 */
export function payloadHashFromHtml(html: string): string | undefined {
  const text = payloadTextFromHtml(html);
  if (text === undefined) return undefined;
  return computePayloadHash(text);
}

/**
 * The `#fish-assets` block, kept for as long as the asset list it describes.
 *
 * Turned into pretty JSON on every save, that block is 39.6 MB of base64 for a
 * list that only changes when an image is added or replaced — the single largest
 * cost of an auto-save that changed nothing but a text layer. Keyed on the
 * array's identity: documents are updated immutably, and the URIs are derived
 * from that array alone.
 */
const assetBlockCache = new WeakMap<readonly AssetRef[], string>();

function assetsBlockFor(assets: readonly AssetRef[] | undefined, uris: Record<string, string>): string {
  if (Object.keys(uris).length === 0) return "";
  const cached = assets ? assetBlockCache.get(assets) : undefined;
  if (cached !== undefined) return cached;
  const block = `\n  <script id="fish-assets" type="application/json">\n${JSON.stringify(uris, null, 2).replace(
    /<\//g,
    "\\u003c/"
  )}\n  </script>`;
  if (assets) assetBlockCache.set(assets, block);
  return block;
}

export type PreviewGenerator = (doc: DesignDocument) => string | null;
let activePreviewGenerator: PreviewGenerator | null = null;

export function registerPreviewGenerator(fn: PreviewGenerator | null): void {
  activePreviewGenerator = fn;
}

/**
 * A generated cover goes into the file, so it may only be markup a parser cannot
 * get lost in: the two markers that delimit it, no script (a cover that writes code
 * into every saved document is a cost the picture never earned), no stray
 * `</noscript>` or `</style>` that would close a region it did not open.
 */
export function isSafePreviewHtml(html: string): boolean {
  if (!html.includes('data-fish-preview="1"')) return false;
  if (!html.includes('data-fish-preview-end="1"')) return false;
  const lower = html.toLowerCase();
  if (lower.includes("<script")) return false;
  if (lower.includes("</noscript")) return false;
  const styleOpens = lower.match(/<style/g) || [];
  const styleCloses = lower.match(/<\/style>/g) || [];
  if (styleOpens.length !== styleCloses.length) return false;
  const divOpens = lower.match(/<div\b/g) || [];
  const divCloses = lower.match(/<\/div>/g) || [];
  if (divOpens.length !== divCloses.length) return false;
  return true;
}

export function serializeSelf(
  doc: DesignDocument,
  templateHtml?: string,
  opts?: { freshFileId?: boolean; title?: string; comments?: FishCommentsDocument }
): string {
  // `toDocumentText` folds the live mirror into its page *before* normalizing.
  // Order matters: normalizing first would read the page record — which is the
  // pre-drag state while a gesture is in flight — and the drag would be saved as
  // it looked before it started. It also drops the mirror from the text, so this
  // block holds one element tree rather than two.
  const { json, assetUris: uris } = toDocumentText(doc, { pretty: true, assets: "external" });
  // Only "</" needs escaping: that is the one sequence that can physically
  // terminate the #design-doc block from inside a string value. Escaping every
  // "<" also worked, but it made ordinary text unreadable on disk and invisible
  // to grep.
  const jsonString = json.replace(/<\//g, "\\u003c/");
  const jsonScriptBlock = `<script id="design-doc" type="application/json">\n${jsonString}\n  </script>`;
  // Omitted entirely when there is nothing to hold: an empty block would be
  // pure noise in every document that has no bitmaps.
  const assetsScriptBlock = assetsBlockFor(doc.assets, uris);

  let targetHtml = templateHtml ?? pristineHtml;
  if (!targetHtml) {
    capturePristine();
    targetHtml = pristineHtml;
  }

  const commentsDoc = opts?.comments ?? getActiveComments() ?? parseCommentsBlock(targetHtml);
  const commentsScriptBlock =
    commentsDoc.threads.length === 0
      ? ""
      : `\n  <script id="fish-comments" type="application/json">\n${JSON.stringify(commentsDoc, null, 2).replace(
          /<\//g,
          "\\u003c/"
        )}\n  </script>`;

  // Stamp a file identity into the shell the first time we write it. The id has
  // to be read from the live DOM, never scanned out of the HTML text: the
  // inlined bundle contains the literal `fish:fileId` in its own source, so a
  // text search finds the *code* rather than the tag and returns the same
  // placeholder for every file — one identity shared by everything, which is
  // exactly the failure this identity is here to prevent.
  // A "Save As" / "New File" / version export is a new, independent file and must
  // not inherit the source's `fish:fileId` — that id also keys the recovery
  // snapshot, version timeline and FSA handle, so sharing it would make two files
  // collide on one history and one write-back target. Same-file writes (save,
  // shell upgrade) omit the flag and keep the id they already carry.
  const fileId = opts?.freshFileId ? mintFileId() : (readFileIdFromShell() ?? mintFileId());
  const metaTag = `<meta name="fish:fileId" content="${fileId}">`;

  // The replacement is a function, never a template string. A string replacement
  // is a pattern, not data: `$1` / `$&` / `` $` `` in the document would be
  // expanded against this regex's captures and splice shell markup into the
  // JSON — a `$196.4K` label came back as `<meta name="fish:fileId" …>`, which
  // no longer parses. The CLI writers already pass a function for this reason.
  const injectedBlocks = `${metaTag}\n  ${jsonScriptBlock}${commentsScriptBlock}${assetsScriptBlock}`;
  let resultHtml = "";
  if (BOTH_BLOCKS_RE.test(targetHtml)) {
    resultHtml = targetHtml.replace(BOTH_BLOCKS_RE, () => injectedBlocks);
  } else if (/<head[^>]*>/i.test(targetHtml)) {
    resultHtml = targetHtml.replace(
      /<head[^>]*>/i,
      (m) => `${m}\n  ${injectedBlocks}`
    );
  } else {
    resultHtml = `<!DOCTYPE html>\n<html>\n<head>\n  ${injectedBlocks}\n</head>\n<body>\n${targetHtml}\n</body>\n</html>`;
  }

  // The name of the file being written, when the caller knows it. The tab's own
  // title is not that answer: a save-as lands in a file this tab never opened,
  // and an update transplants a shell whose title is the release's, so the title
  // is derived from the target here rather than read off the page.
  const title = opts?.title ?? documentTitleFor(getFileName(), doc.name);

  // Remove any existing preview blocks so they never accumulate on re-saves.
  resultHtml = stripCoverBlock(resultHtml);

  // Before the preview is injected: the stamp is scoped to the head, and keeping
  // it out of the body's half of the function is what proves the scoping.
  if (title) resultHtml = stampDocumentTitle(resultHtml, title);

  if (activePreviewGenerator) {
    try {
      const previewHtml = activePreviewGenerator(doc);
      if (previewHtml && isSafePreviewHtml(previewHtml)) {
        resultHtml = insertCoverBlock(resultHtml, previewHtml);
      }
    } catch (err) {
      console.warn("FISH: Failed to generate thumbnail preview:", err);
    }
  }

  return resultHtml;
}

/**
 * Parse a `.fish.html` back into a document. Used to recover from a file whose
 * document block we failed to load — the copy we kept before our last write is
 * a full shell, so it goes through the same reader as any other file.
 */
export function documentFromHtml(html: string): DesignDocument | undefined {
  const match = DOC_BLOCK_RE.exec(html);
  const body = match?.[1]?.trim();
  if (!body) return undefined;
  try {
    const parsed = mergeAssets(
      parseLenientJson<DesignDocument>(body.replace(/\\u003c/g, "<")),
      parseAssetsBlock(html)
    );
    return readDocument(parsed);
  } catch {
    return undefined;
  }
}


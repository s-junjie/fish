import { DesignDocument, getActivePage, updateActivePageElements } from "./dsl/types";
import { DEFAULT_CANVAS_BACKGROUND } from "./dsl/defaults";
import { mintDocId, mintFileId } from "./id";
import { normalizeDesignDocument } from "./dsl/normalize";
import { parseLenientJson } from "./dsl/lenient-json";
import { LATEST_DOCUMENT_VERSION } from "./dsl/version";
import { relayoutDocumentTree } from "./compile";
import { instanceSizeResolver } from "./interactions/instance-size";
import { syncDocumentBindings } from "./interactions/style-ops";
import { computePayloadHash } from "./persistence/recovery";
import { IdbBackend, MemoryBackend, hasIndexedDb } from "./persistence/backend";
import { documentTitleFor, stampDocumentTitle } from "./document-title";
import { toDocumentText } from "./document-json";
import { insertCoverBlock, stripCoverBlock } from "./cover-block";
import { FishCommentsDocument, createEmptyCommentsDocument } from "./comments/types";
import { mergeCommentsDocuments } from "./comments/merge";
import { refreshFontStatus } from "./fonts/font-status";

let pristineHtml = "";
let currentFileHandle: any = null;

/** Read the active FSA handle (null until the user saves or restores one). */
export function getFileHandle(): any {
  return currentFileHandle;
}

/** Set the active FSA handle (used by the auto-save layer to restore it). */
export function setFileHandle(handle: any): void {
  currentFileHandle = handle;
}

/**
 * Name of the file this page was opened from, taken from the URL. A `file://`
 * page has no way to obtain a handle to its own file, so this is the only
 * ground truth about "which file am I looking at" — and the name that must be
 * offered when we do ask the user to pick a write-back target.
 */
export function openedFileName(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const base = (window.location?.pathname ?? "").split("/").pop();
  if (!base) return undefined;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

export function openedFilePath(): string | undefined {
  if (typeof window === "undefined" || window.location?.protocol !== "file:") return undefined;
  const raw = window.location.pathname ?? "";
  if (!raw) return undefined;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.replace(/^\/([a-zA-Z]:)/, "$1");
  } catch {
    return raw.replace(/^\/([a-zA-Z]:)/, "$1");
  }
}

export function openedFileDirectory(): string | undefined {
  const path = openedFilePath();
  if (!path) return undefined;
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return undefined;
  return path.substring(0, lastSlash) || "/";
}

const WELL_KNOWN_DIRECTORIES = ["desktop", "documents", "downloads", "pictures", "music", "videos"] as const;

/**
 * The well-known directory a path sits *directly* in, if any.
 *
 * Exact, not nearest: `startIn` carries the folder's name and nothing else, so
 * answering `"documents"` for a file three levels below `~/Documents` opens the
 * picker at `~/Documents` — a wrong answer wearing a helpful face, and the one
 * the user reads as "it forgot where my file is". A path that is not directly
 * inside one of these gets `undefined`, which lets the browser fall back to the
 * folder it remembers instead of being dragged somewhere unrelated.
 */
export function wellKnownDirectoryOf(path?: string): string | undefined {
  if (!path) return undefined;
  const parent = path.replace(/[\\/][^\\/]*$/, "");
  const name = parent.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
  if (!name) return undefined;
  if (name === "movies") return "videos";
  return (WELL_KNOWN_DIRECTORIES as readonly string[]).includes(name) ? name : undefined;
}

/** A handle or a well-known directory name — the two things `startIn` takes. */
export type PickerStartIn = string | { readonly name?: string };

/**
 * The `startIn` every picker in the app gets: the folder this document lives
 * in, when the page can prove which one that is.
 *
 * A handle is proof — Chromium opens the picker in the parent directory of a
 * file handle, so Save As lands beside the `.fish.html` being edited. Without
 * one, all a `file://` page knows is its own URL, and `wellKnownDirectoryOf`
 * turns that into a hint only when the hint is exactly right.
 */
export function pickerStartIn(): PickerStartIn | undefined {
  return currentFileHandle ?? wellKnownDirectoryOf(openedFilePath());
}

/** Where a save or auto-save write-back will land: the handle if we have one. */
export function getFileName(): string | undefined {
  return (currentFileHandle?.name as string | undefined) ?? openedFileName();
}

const FILE_ID_META_RE = /<meta\s+name=["']fish:fileId["']\s+content=["']([^"']+)["']/i;

/**
 * The `<meta name="fish:fileId">` carried by the shell of the open file.
 *
 * DOM only, deliberately: scanning `outerHTML` would also match the literal
 * `fish:fileId` sitting inside the inlined bundle's own source code, and the id
 * would come back as that literal — the same value for every file, which is
 * precisely what this identity exists to prevent.
 */
export function readFileIdFromShell(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const meta = document.querySelector?.('meta[name="fish:fileId"]');
  return meta?.getAttribute("content") ?? undefined;
}

/** The `fish:fileId` stamp carried by an HTML string, for a file not yet adopted. */
export function fileIdFromHtml(html: string): string | undefined {
  return FILE_ID_META_RE.exec(html)?.[1];
}

/**
 * Identity of the file this tab is editing, independent of what is inside it.
 *
 * Local recovery and version history are keyed on this rather than on the
 * document's `docId`: `docId` is read out of the document body, so a file that
 * fails to parse yields no `docId` and its snapshots become unreachable — the
 * backup vanishes precisely when it is the only way back. The shell survives
 * truncation of the document block, so the meta stays readable.
 */
export function getFileId(): string {
  const fromShell = readFileIdFromShell();
  if (fromShell) return fromShell;
  const name = getFileName();
  return name ? `byname_${name}` : "unknown-file";
}

// A document with nothing in it: the fallback whenever a file carries no
// readable #design-doc block. The showcase content lives in the source
// index.html, so an empty shell must not invent a document the user never authored.
export function createEmptyDocument(): DesignDocument {
  const canvas: DesignDocument["canvas"] = {
    width: 1920,
    height: 1080,
    unit: "px",
    background: { type: "solid", color: DEFAULT_CANVAS_BACKGROUND }
  };
  const now = new Date().toISOString();
  return {
    docId: mintDocId(),
    id: "fish_doc_empty",
    version: LATEST_DOCUMENT_VERSION,
    name: "Untitled",
    createdAt: now,
    updatedAt: now,
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children: [] }],
    activePageId: "page_1"
  };
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

/**
 * `computePayloadHash` of the design-document block exactly as the file held it,
 * captured once at boot. Letting the user pick a write-back target is only safe
 * if we can prove the file they picked is the one open in this tab, and this is
 * the baseline that proof compares against.
 *
 * Hashed from the file's own text rather than from the parsed document: a
 * comparison that went through normalize would refuse the user's own file the
 * moment the normalizer changed.
 */
let openedFileHash: string | undefined;

export function getOpenedFileHash(): string | undefined {
  return openedFileHash;
}

/** Re-anchor the identity check after the tab adopts a different file. */
export function setOpenedFileHash(payloadHash: string | undefined): void {
  openedFileHash = payloadHash;
}

/**
 * The one way a raw document becomes a live one.
 *
 * Every reader goes through it — the file being opened, the file the user picks
 * as a write-back target, a recovered backup — because they have to agree. If
 * one loader normalized and the others did not, the same content would hash
 * differently and the identity check would refuse the user's own file.
 */
function readDocument(raw: unknown): DesignDocument {
  // Materialised last, so a file that only names its styles still paints them:
  // the renderer reads `el.style` / `el.fills` and never resolves an id.
  return syncDocumentBindings(normalizeDesignDocument(raw, { preserveUnknown: true }).document);
}

const DOC_BLOCK_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;
const COMMENTS_BLOCK_RE = /<script\s+id=["']fish-comments["'][^>]*>([\s\S]*?)<\/script>/i;
const ASSETS_BLOCK_RE = /<script\s+id=["']fish-assets["'][^>]*>([\s\S]*?)<\/script>/i;
const BOTH_BLOCKS_RE =
  /(<meta\s+name=["']fish:fileId["'][^>]*>\s*)?<script\s+id=["']design-doc["'][^>]*>[\s\S]*?<\/script>((\s*<script\s+id=["']fish-comments["'][^>]*>[\s\S]*?<\/script>)|(\s*<script\s+id=["']fish-assets["'][^>]*>[\s\S]*?<\/script>))*/i;

/** Put the URIs back, given the parsed `fish-assets` block (if any). */
function mergeAssets(doc: DesignDocument, uris: Record<string, string>): DesignDocument {
  if (!doc.assets || doc.assets.length === 0) return doc;
  return {
    ...doc,
    assets: doc.assets.map((ref) => {
      const uri = uris[ref.id];
      return uri ? { ...ref, uri } : ref;
    })
  };
}

function parseAssetsBlock(html: string): Record<string, string> {
  const body = ASSETS_BLOCK_RE.exec(html)?.[1]?.trim();
  if (!body) return {};
  try {
    const parsed = JSON.parse(body.replace(/\\u003c/g, "<"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function parseCommentsBlock(html: string): FishCommentsDocument {
  const body = COMMENTS_BLOCK_RE.exec(html)?.[1]?.trim();
  if (!body) return createEmptyCommentsDocument();
  try {
    const parsed = JSON.parse(body.replace(/\\u003c/g, "<"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.threads)) {
      return {
        version: parsed.version || "0.1",
        threads: parsed.threads
      };
    }
    return createEmptyCommentsDocument();
  } catch {
    return createEmptyCommentsDocument();
  }
}

export function loadInitialComments(): FishCommentsDocument {
  if (typeof document === "undefined") {
    return createEmptyCommentsDocument();
  }
  const scriptEl = document.getElementById("fish-comments");
  if (!scriptEl || !scriptEl.textContent || !scriptEl.textContent.trim()) {
    return createEmptyCommentsDocument();
  }
  try {
    const parsed = JSON.parse(scriptEl.textContent.replace(/\\u003c/g, "<"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.threads)) {
      return {
        version: parsed.version || "0.1",
        threads: parsed.threads
      };
    }
  } catch (err) {
    console.warn("FISH: Failed to parse embedded #fish-comments JSON:", err);
  }
  return createEmptyCommentsDocument();
}

let activeCommentsDoc: FishCommentsDocument | null = null;

/**
 * Thread ids this session deleted.
 *
 * A merge cannot read a deletion out of a timestamp: the file still has the
 * thread, with no marker saying it went away here. Remembering the ids is what
 * stops a write from resurrecting a comment the user just removed.
 */
const deletedCommentIds = new Set<string>();

const commentsReplacedListeners = new Set<(comments: FishCommentsDocument) => void>();

export function setActiveComments(comments: FishCommentsDocument | null): void {
  activeCommentsDoc = comments;
}

export function getActiveComments(): FishCommentsDocument | null {
  return activeCommentsDoc;
}

export function noteCommentDeleted(threadId: string): void {
  deletedCommentIds.add(threadId);
}

export function noteCommentRestored(threadId: string): void {
  deletedCommentIds.delete(threadId);
}

/**
 * Told when a write pulled a newer comment block out of the file.
 *
 * The writer is not a React component, so this is how the adopted threads reach
 * the UI: without it the merge would be correct on disk and invisible on
 * screen until the next reload.
 */
export function onCommentsReplaced(listener: (comments: FishCommentsDocument) => void): () => void {
  commentsReplacedListeners.add(listener);
  return () => commentsReplacedListeners.delete(listener);
}

export function spliceCommentsBlock(html: string, comments: FishCommentsDocument): string {
  const hasComments = comments.threads.length > 0;
  const commentsJson = hasComments
    ? JSON.stringify(comments, null, 2).replace(/<\//g, "\\u003c/")
    : "";
  const commentsScriptBlock = hasComments
    ? `\n  <script id="fish-comments" type="application/json">\n${commentsJson}\n  </script>`
    : "";

  if (COMMENTS_BLOCK_RE.test(html)) {
    if (hasComments) {
      return html.replace(COMMENTS_BLOCK_RE, () => commentsScriptBlock.trim());
    }
    return html.replace(new RegExp(`\\s*${COMMENTS_BLOCK_RE.source}`, "i"), "");
  }

  if (DOC_BLOCK_RE.test(html)) {
    if (!hasComments) return html;
    return html.replace(DOC_BLOCK_RE, (match) => `${match}${commentsScriptBlock}`);
  }

  return html;
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
 * Set when the file carried a `#design-doc` block that could not be read.
 *
 * The empty document is still returned so the app can boot, but the caller must
 * surface this: silently replacing someone's work with a blank canvas and no
 * explanation is how a corrupt file turns into a lost document.
 */
let loadFailure: string | undefined;

export function getLoadFailure(): string | undefined {
  return loadFailure;
}

export function loadInitialDocument(): DesignDocument {
  if (typeof document === "undefined") {
    return createEmptyDocument();
  }

  const scriptEl = document.getElementById("design-doc");
  // Read before anything is parsed or validated: the identity of the file is a
  // property of its bytes, so it must not depend on whether we could read them.
  openedFileHash = computePayloadHash(scriptEl?.textContent ?? "");
  if (!scriptEl || !scriptEl.textContent || !scriptEl.textContent.trim()) {
    return createEmptyDocument();
  }

  try {
    const parsed = mergeAssets(
      parseLenientJson<DesignDocument>(scriptEl.textContent.trim()),
      parseAssetsBlock(document.documentElement?.outerHTML ?? "")
    );
    if (!parsed.docId) {
      parsed.docId = mintDocId();
    }
    // A `$schema` pointing at a URL that does not resolve is worse than no
    // `$schema` at all: it promises a contract that cannot be read. Dropped
    // rather than invented, here and in `createEmptyDocument`.
    delete parsed.$schema;
    const normalized = readDocument(parsed);
    // Before the first layout. A family this machine does not have has to be
    // known BEFORE anything measures: the layout pass below writes `fit-content`
    // boxes, and a box sized in a substitute's metrics is the author's layout
    // destroyed — permanently, in the file, on the one machine that could not
    // show it. `resolveTextSizing` consults the same answer, so this is the call
    // that makes the freeze effective rather than decorative.
    refreshFontStatus(normalized);
    // The active page, not just the mirror: on a multi-page file the mirror is
    // ignored by readers, so relayouting it alone would drop the measurements.
    return updateActivePageElements(
      normalized,
      relayoutDocumentTree(
        getActivePage(normalized).children,
        instanceSizeResolver(normalized)
      )
    );
  } catch (err) {
    console.warn("FISH: Failed to parse embedded #design-doc JSON, falling back to an empty document:", err);
    loadFailure = err instanceof Error ? err.message : String(err);
    return createEmptyDocument();
  }
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
  const assetIds = Object.keys(uris);
  const assetsScriptBlock =
    assetIds.length === 0
      ? ""
      : `\n  <script id="fish-assets" type="application/json">\n${JSON.stringify(uris, null, 2).replace(
          /<\//g,
          "\\u003c/"
        )}\n  </script>`;

  let targetHtml = templateHtml ?? pristineHtml;
  if (!targetHtml) {
    capturePristine();
    targetHtml = pristineHtml;
  }

  const commentsDoc = opts?.comments ?? activeCommentsDoc ?? parseCommentsBlock(targetHtml);
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

const backupBackend = hasIndexedDb() ? new IdbBackend() : new MemoryBackend();

/**
 * Keep the file's current contents before we overwrite it.
 *
 * Not a `.bak` file: writing a sibling file needs `showSaveFilePicker` and
 * therefore a user gesture, so it cannot happen inside an auto-save flush. The
 * copy goes to IndexedDB instead, keyed by file identity, and is what makes a
 * corrupt file recoverable — the state right before our own last write.
 *
 * Reports failure instead of swallowing it. The caller decides what an absent
 * safety net means, because it does not mean the same thing everywhere: an
 * explicit ⌘S is the user's own call, but an unprompted auto-save write that
 * cannot be undone should not proceed on top of no copy.
 */
async function backupBeforeWrite(
  handle: unknown
): Promise<{ ok: true; text?: string } | { ok: false; reason: string }> {
  try {
    const getFile = (handle as { getFile?: () => Promise<{ text: () => Promise<string> }> } | null)?.getFile;
    if (typeof getFile !== "function") return { ok: false, reason: "no-getFile" };
    const text = await (await getFile.call(handle)).text();
    // An empty file has no work to lose, so there is nothing to back up. Refusing
    // here made the first write into a freshly created file impossible.
    if (!text) return { ok: true, text };
    await backupBackend.put("backups", {
      key: getFileId(),
      text,
      at: new Date().toISOString()
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
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

/** Contents of the file as of just before our last write to it. */
export async function readFileBackup(fileId: string): Promise<string | undefined> {
  try {
    const row = (await backupBackend.get("backups", fileId)) as { text?: string } | undefined;
    return row?.text;
  } catch {
    return undefined;
  }
}

export interface WriteOutcome {
  /** The file was rewritten. */
  ok: boolean;
  /** Why it was not, when `ok` is false. */
  reason?: string;
  /** The write landed but there is no pre-write copy to fall back on. */
  backupFailed?: boolean;
  /**
   * `computePayloadHash` of the bytes that landed. This is what the fork anchor
   * re-anchors to, so it must describe the file, not the doc we meant to write.
   */
  payloadHash?: string;
}

interface WritableStreamLike {
  write: (s: string) => Promise<void>;
  truncate?: (size: number) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
}

/**
 * The single write path for a `.fish.html`. Both the explicit save and the
 * silent auto-save write-back go through here, so the pre-write backup can
 * never be skipped by one of them — an auto-save that overwrote the file every
 * two seconds without a backup would be the most dangerous writer in the app.
 *
 * `keepExistingData: true` is the load-bearing part. `createWritable()` defaults
 * it to false, which truncates the file to zero bytes *before* `write` is even
 * called: a quota or permission error anywhere in the write then leaves the
 * user with an empty file. Keeping the existing data makes the write land in a
 * temp file that only replaces the original on `close()`, and `abort()` on
 * failure throws that temp file away with the original untouched. Its cost is
 * that the temp file keeps the original's length until `truncate` below, which
 * is why the two only work as a pair.
 */
/**
 * Reconcile the live comment block with the one the file holds, just before it
 * is overwritten.
 *
 * `writeFileSafely` replaces the whole container, including `#fish-comments`.
 * An agent running `fish comments suggest` has meanwhile written that block by
 * itself — and the document's identity check cannot see it, because the comment
 * block is deliberately outside `#design-doc`. This is the one place that knows
 * both sides, so it is where the two are merged (`mergeCommentsDocuments`).
 *
 * Only the file this tab opened is reconciled: a save-as target is a different
 * document, and adopting its threads would import a stranger's conversation.
 */
function reconcileCommentsWithFile(text: string | undefined): FishCommentsDocument | undefined {
  if (!text) return undefined;
  const targetId = fileIdFromHtml(text);
  const ownId = readFileIdFromShell();
  if (!targetId || !ownId || targetId !== ownId) return undefined;

  const remote = parseCommentsBlock(text);
  const local = activeCommentsDoc;
  if (!local) {
    if (remote.threads.length === 0) return undefined;
    setActiveComments(remote);
    return remote;
  }

  const { document, changed } = mergeCommentsDocuments(local, remote, deletedCommentIds);
  if (!changed) return local;
  // The file's answer to a comment is a state the user asked for: adopt it here
  // so the card and the rail show it, instead of holding it on disk only.
  setActiveComments(document);
  for (const listener of commentsReplacedListeners) listener(document);
  return document;
}

export async function writeFileSafely(
  doc: DesignDocument,
  handle: unknown,
  templateHtml?: string,
  opts: { requireBackup?: boolean } = {}
): Promise<WriteOutcome> {
  const backup = await backupBeforeWrite(handle);
  if (!backup.ok && opts.requireBackup) {
    return { ok: false, reason: `backup-unavailable:${backup.reason}` };
  }
  // A fresh timestamp on a copy: `doc` is referenced by undo snapshots, so
  // writing it in place would silently rewrite history entries.
  // The handle's own name, because this write lands in *that* file — which is
  // not necessarily the one this tab was opened from.
  const targetName = (handle as { name?: string } | null)?.name;
  const mergedComments = reconcileCommentsWithFile(backup.ok ? backup.text : undefined);
  const fileContent = serializeSelf({ ...doc, updatedAt: new Date().toISOString() }, templateHtml, {
    title: documentTitleFor(targetName, doc.name),
    ...(mergedComments ? { comments: mergedComments } : {})
  });
  const writable = (handle as { createWritable: (o?: unknown) => Promise<WritableStreamLike> }).createWritable;
  let stream: WritableStreamLike | undefined;
  try {
    stream = await writable.call(handle, { keepExistingData: true });
    await stream.write(fileContent);
    // `keepExistingData` starts the temp file as a copy of the file being
    // replaced, and `write` never shortens it. Without this cut, saving a
    // document smaller than the file it lands in leaves the previous file's tail
    // behind: a second runtime payload and a second `#app`, which the shell
    // refuses to boot. The length is bytes, not characters.
    await stream.truncate?.(new TextEncoder().encode(fileContent).byteLength);
    await stream.close();
    // The deletions are on disk now, so remembering them can only do harm: a
    // thread an agent legitimately re-adds under the same id would be dropped.
    deletedCommentIds.clear();
  } catch (err) {
    // Best effort: abort() only means anything while the temp file is still open,
    // and a close() that threw may already have released it. Never let this mask
    // the original failure.
    try {
      await stream?.abort?.();
    } catch {
      // already closed or aborted
    }
    throw err;
  }
  // The file on disk now carries a fileId stamp. Mirror it into this page so the
  // id stays stable for the rest of the session: `getFileId` reads the DOM, and
  // the handle is persisted under that id. Without this the handle would be
  // filed under the name-derived fallback id, which the next load — now reading
  // the stamp out of the file — would never look up, so the user would be asked
  // to pick the file again on every single open.
  const writtenId = FILE_ID_META_RE.exec(fileContent)?.[1];
  if (writtenId) adoptFileId(writtenId);
  const payloadHash = payloadHashFromHtml(fileContent);
  // The file on disk now holds these bytes, and the identity check proves a
  // picked handle against the file as it was OPENED — a baseline left at boot
  // refuses the user's own file as soon as that file has moved on, which it has
  // after an explicit save or after auto-save has been writing for a while.
  // Not moved when the write landed in a differently named file: a ⌘S save-as
  // is not the file this tab is showing, and adopting it would make the next
  // relink accept that copy.
  // `getFileName` (handle first) rather than the URL: once a save-as has adopted
  // the new handle this tab is editing that file, and every later auto-save of
  // it must move the baseline too. Before adoption the handle is still the old
  // one, so a save-as write leaves the original file's baseline alone.
  const opened = getFileName();
  if (!targetName || !opened || targetName === opened) openedFileHash = payloadHash;
  return {
    ok: true,
    payloadHash,
    ...(backup.ok ? {} : { backupFailed: true })
  };
}

export function adoptFileId(fileId: string): void {
  if (typeof document === "undefined" || !document.head) return;
  const existing = document.querySelector?.('meta[name="fish:fileId"]');
  if (existing) {
    existing.setAttribute("content", fileId);
    return;
  }
  const meta = document.createElement("meta");
  meta.setAttribute("name", "fish:fileId");
  meta.setAttribute("content", fileId);
  document.head.appendChild(meta);
}

export async function saveInPlace(doc: DesignDocument): Promise<{ success: boolean; method: "fsa" | "download"; filename: string; error?: string; payloadHash?: string }> {
  let templateHtml: string | undefined;
  // Serialize a copy with a fresh timestamp instead of mutating the live
  // document: `doc` is referenced by undo snapshots, so an in-place write here
  // would silently rewrite history entries and break the immutable invariant.
  const docToWrite: DesignDocument = { ...doc, updatedAt: new Date().toISOString() };

  // In Vite dev mode, document.documentElement.outerHTML contains unbundled Vite dev script tags
  // which causes the exported HTML to be blank when opened standalone via file://.
  // We fetch the standalone single-file bundle from the dev server if running under dev mode.
  if (typeof window !== "undefined" && ((import.meta as any).env?.DEV || window.location?.port === "5173")) {
    try {
      const res = await fetch("/__fish_bundle__");
      if (res.ok) {
        templateHtml = await res.text();
      } else {
        const distRes = await fetch("/dist/index.html");
        if (distRes.ok) {
          templateHtml = await distRes.text();
        }
      }
    } catch {
      // Fallback to pristineHtml
    }
  }

  // Default to the name of the file being edited. Falling back to the document
  // name here made "save" look like "save as": the picker offered an unrelated
  // name, users accepted it, and auto-save then wrote to a file that was not
  // the one open in the tab — with the URL still pointing at the original.
  const filename =
    openedFileName() || `${(doc.name || "untitled").toLowerCase().replace(/\s+/g, "-")}.fish.html`;

  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      if (currentFileHandle) {
        let perm = "granted";
        if (typeof currentFileHandle.queryPermission === "function") {
          try {
            perm = await currentFileHandle.queryPermission({ mode: "readwrite" });
          } catch {
            perm = "prompt";
          }
        }
        if (perm === "prompt" && typeof currentFileHandle.requestPermission === "function") {
          try {
            perm = await currentFileHandle.requestPermission({ mode: "readwrite" });
          } catch {
            perm = "denied";
          }
        }
        if (perm !== "granted") {
          currentFileHandle = null;
        }
      }

      if (!currentFileHandle) {
        const startIn = pickerStartIn();
        currentFileHandle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          id: "fish-document",
          ...(startIn ? { startIn } : {}),
          types: [
            {
              description: "FISH Single-File Design Document (*.fish.html)",
              accept: { "text/html": [".html", ".htm"] }
            }
          ]
        });
      }

      // Routed through the shared writer so the pre-write backup is taken here
      // too — this is the one path the auto-save layer does not control. The
      // user asked for this save, so a missing backup is reported rather than
      // treated as a reason to refuse.
      const outcome = await writeFileSafely(doc, currentFileHandle, templateHtml);
      if (!outcome.ok) {
        return { success: false, method: "fsa", filename, error: outcome.reason };
      }

      return {
        success: true,
        method: "fsa",
        filename: currentFileHandle.name || filename,
        payloadHash: outcome.payloadHash
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { success: false, method: "fsa", filename };
      }
      currentFileHandle = null;
      // A failed in-place write is not a save. This used to fall through to the
      // download branch and return `success: true`, which made the UI claim the
      // file was written and re-anchored the fork to content the file did not
      // hold. It also does not silently download: an unexpected download is the
      // "save became save-as" trap the filename default above exists to avoid.
      // The recovery snapshot still holds the work, and the status tells the user.
      return {
        success: false,
        method: "fsa",
        filename,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // No File System Access API at all — a download is the only way to save.
  // The title is named from `filename`, which on this path is the file being
  // written: the tab may be looking at a `file://` page this download replaces.
  const fileContent = serializeSelf(docToWrite, templateHtml, {
    title: documentTitleFor(filename, docToWrite.name)
  });
  const blob = new Blob([fileContent], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { success: true, method: "download", filename };
}

export function clearFileHandle(): void {
  currentFileHandle = null;
}

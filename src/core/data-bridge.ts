import { DesignDocument, getActivePage, updateActivePageElements } from "./dsl/types";
import { DEFAULT_CANVAS_BACKGROUND } from "./dsl/defaults";
import { mintDocId } from "./id";
import { parseLenientJson } from "./dsl/lenient-json";
import { LATEST_DOCUMENT_VERSION } from "./dsl/version";
import { relayoutDocumentTree } from "./compile";
import { instanceSizeResolver } from "./interactions/instance-size";
import { computePayloadHash } from "./persistence/recovery";
import { refreshFontStatus } from "./fonts/font-status";
import { mergeAssets, parseAssetsBlock, readDocument } from "./persistence/container";
import { setOpenedFileHash } from "./persistence/save-in-place";

// Re-export subsystems to preserve complete backward compatibility
export * from "./persistence/file-handle";
export * from "./persistence/file-paths";
export * from "./persistence/file-identity";
export * from "./comments/comments-bridge";
export * from "./persistence/container";
export * from "./persistence/save-in-place";

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
  setOpenedFileHash(computePayloadHash(scriptEl?.textContent ?? ""));
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

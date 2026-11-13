import { useMemo, useRef, useState } from "preact/hooks";
import { getActivePage } from "../../core/dsl/document-ops";
import { flattenElements } from "../../core/geometry/tree-ops";
import { useBlockBrowserZoom } from "../hooks/useBlockBrowserZoom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useEditorStore } from "../hooks/useEditorStore";
import { useFishBridge } from "../hooks/useFishBridge";
import { useFontStatusSync } from "../hooks/useFontStatusSync";
import { useHeadlessReport } from "../hooks/useHeadlessReport";
import { useReadOnlyLock } from "../hooks/useReadOnlyLock";
import { useTestBridge } from "../hooks/useTestBridge";
import { CanvasOnlyView } from "./CanvasOnlyView";

export interface CanvasOnlyRootProps {
  /** The file's own policy, read once by the entry. */
  readOnly: boolean;
}

/** The embed has no camera: it paints at 1:1 with the document's own origin. */
const EMBED_VIEWPORT = { zoom: 1, pan: { x: 0, y: 0 } };

/**
 * `?view=canvas`, assembled.
 *
 * Everything the screenshot and export paths need, and nothing that edits: the
 * document, a container to measure it in, the headless report channel, and
 * `window.__fish` — an agent that inspects an embed must still be able to.
 * `useHeadlessReport` lives here rather than in the editor because this is the
 * only shell that answers `?report=1`; every caller in the repo asks for it
 * together with `view=canvas`.
 */
export function CanvasOnlyRoot({ readOnly }: CanvasOnlyRootProps) {
  useBlockBrowserZoom();
  const { store, doc, docRef, commitSnapshot, undo, redo } = useEditorStore();
  useReadOnlyLock(store, readOnly);
  // Before anything paints: `missing` is a fact about the file on this machine,
  // and the export reads it without ever touching the canvas renderer.
  useFontStatusSync(doc);
  useDocumentTitle(doc);

  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const canvasTextInputRef = useRef<HTMLTextAreaElement>(null);
  const headlessOrigin = useHeadlessReport(doc, docRef, canvasContainerRef);
  // `activePage.children` rather than the page object: the page is rebuilt on a
  // commit while its element array is stable, so this is the key that memoizes.
  const activePage = getActivePage(doc);
  const allElements = useMemo(() => flattenElements(activePage.children), [activePage.children]);

  useFishBridge({
    docRef,
    canvasContainerRef,
    zoom: EMBED_VIEWPORT.zoom,
    pan: EMBED_VIEWPORT.pan
  });

  // `__FISH_BRIDGE__` is how a probe puts a document on this surface at all: the
  // embed has no file picker and no layers panel. It lived in the single entry
  // before the shells were split, and leaving it out here silently stranded every
  // spec that measures the embed (`link`, `typography`). Selection is state a
  // viewing surface never uses, but the bridge's shape is the editor's, and a
  // second shape would be a second contract.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  useTestBridge({ docRef, selectedIds, setSelectedIds, commitSnapshot, undo, redo });

  return (
    <CanvasOnlyView
      canvasContainerRef={canvasContainerRef}
      headlessOrigin={headlessOrigin}
      doc={doc}
      allElements={allElements}
      docRef={docRef}
      canvasTextInputRef={canvasTextInputRef}
    />
  );
}

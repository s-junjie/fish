import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DesignDocument, InstanceElement } from "../../core/dsl/types";
import { isLaidOut, relayoutDocumentTree } from "../../core/compile";
import { flattenElements } from "../../core/geometry/tree-ops";
import { mapElements } from "../../core/geometry/tree-edit";
import { findElementAtPoint } from "../../core/geometry/tree-hit";
import { canContainerScroll, clampScrollOffset, computeContainerScrollBounds, findScrollableContainersAtPoint } from "../../core/geometry/scroll-bounds";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { contentBounds } from "../../core/geometry/element-bounds";
import { formatZoomPercent, zoomStep } from "../../core/geometry/viewport";
import { presentationFrames } from "../../core/presentation/frames";
import { t } from "../../i18n";
import { useElementSize } from "../hooks/useElementSize";
import { openLinkFromEvent } from "../link-activation";
import { PresentOverlay } from "../present/PresentOverlay";
import { usePresentation } from "../present/usePresentation";
import { isBrowserReservedKey, presentKey } from "../present/presentKeys";
import { ViewerChrome } from "./ViewerChrome";
import { ViewerStage } from "./ViewerStage";
import { useViewerGestures } from "./useViewerGestures";
import {
  boardBounds,
  cameraViewportBox,
  clampCameraPan,
  fitCamera,
  zoomCameraAt,
  type ViewerCamera
} from "./viewer-camera";
import { editorHref } from "./viewer-mode";

export interface ViewerShellProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  /** The file forbids editing, so there is no door back to the editor. */
  readOnly?: boolean;
}

/** A double tap at or below this zoom means "read it at 1:1" rather than "fit". */
const DOUBLE_TAP_READ_ZOOM = 1;

/**
 * The phone reader: a board you can pan and pinch, a page counter, and a door
 * back to the editor.
 *
 * It is also the read-only shell: a file that forbids editing opens here on
 * every device, because this is the only shell with no write path at all, and
 * a disabled editor reads as a broken one.
 *
 * It owns no document state. Switching pages here does NOT go through
 * `usePageManagement`, because that commits a viewport into the page's metadata
 * and marks the file dirty — a reader that dirties the file it is reading is
 * how a "just looking" session turns into an autosave prompt. The page index is
 * local, and a page that was never laid out is reflowed into a memo instead of
 * into the document.
 */
export function ViewerShell({ doc, docRef, readOnly = false }: ViewerShellProps) {
  const pages = doc.pages;
  const [pageIndex, setPageIndex] = useState(() => {
    const index = pages.findIndex((p) => p.id === doc.activePageId);
    return index >= 0 ? index : 0;
  });
  const page = pages[Math.min(pageIndex, pages.length - 1)] ?? pages[0];

  const elements = useMemo(() => {
    if (!page) return [];
    return isLaidOut(page.children) ? page.children : relayoutDocumentTree(page.children);
  }, [page]);
  const [containerScrolls, setContainerScrolls] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    setContainerScrolls({});
  }, [pageIndex]);

  const displayElements = useMemo(() => {
    if (Object.keys(containerScrolls).length === 0) return elements;
    return mapElements(elements, (el) => {
      const s = containerScrolls[el.id];
      return s ? { ...el, scrollX: s.x, scrollY: s.y } : el;
    });
  }, [elements, containerScrolls]);
  const allElements = useMemo(() => flattenElements(displayElements), [displayElements]);
  const board = useMemo(() => boardBounds(page?.canvas, contentBounds(elements)), [page, elements]);

  const hostRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(hostRef);
  const [camera, setCamera] = useState<ViewerCamera>({ zoom: 1, pan: { x: 0, y: 0 } });
  // The cursor is the reader's only way to say "this board moves" on a device
  // with a pointer: the chrome is three pills and the gestures are invisible.
  const [panning, setPanning] = useState(false);

  const goToPage = useCallback(
    (index: number) => setPageIndex(Math.min(Math.max(index, 0), pages.length - 1)),
    [pages.length]
  );

  /**
   * The deck plays the page being READ, not the document's active page: the
   * reader switches pages without committing one, so `activePageId` still names
   * whatever the editor last had open. The children are the laid-out copy rather
   * than `page.children`, so a slide sits exactly where the stage draws it.
   */
  const presentPage = useMemo(
    () => (page ? { ...page, children: elements } : undefined),
    [page, elements]
  );
  /**
   * A page switch inside the deck is a page switch in the READER, not a private
   * mode of the overlay: leaving the deck has to land on the page just presented.
   * The reader's page index is its own state, so this commits nothing either.
   */
  const handlePresentPageChange = useCallback(
    (pageId: string) => {
      const index = pages.findIndex((p) => p.id === pageId);
      if (index >= 0) goToPage(index);
    },
    [pages, goToPage]
  );
  const present = usePresentation(doc, null, () => {}, presentPage, handlePresentPageChange);

  /**
   * The deck's backdrop, as answered in THIS session.
   *
   * The reader never writes the document (MOBILE.md R7 — after a session the file
   * is byte-identical), so the row that sets it cannot be the stored field the
   * desktop's is. It is kept here instead, per page: the same menu, the same
   * switch, and a reload is the only thing that forgets it. A page the reader has
   * not touched answers `undefined`, which is "read the document".
   */
  const [canvasAnswers, setCanvasAnswers] = useState<Record<string, boolean>>({});
  const answerCanvasBackground = useCallback(
    (value: boolean) => {
      const id = present.page?.id ?? page?.id;
      if (!id) return;
      setCanvasAnswers((current) => ({ ...current, [id]: value }));
    },
    [present.page?.id, page?.id]
  );
  const canPresent = useMemo(
    () => (presentPage ? presentationFrames(doc, presentPage).length > 0 : false),
    [doc, presentPage]
  );

  // Play opens the deck in the shell's own box, exactly as it does on the
  // desktop: going full screen is the deck's fullscreen button, not a
  // consequence of pressing play. A mode that takes the system chrome away
  // before the user asked for it is also the one that is hardest to leave.
  const startPresent = useCallback(() => present.start(), [present]);

  /**
   * The deck's keys.
   *
   * In the editor these come from the shortcut layer, which this shell does not
   * feed — so without this binding a mouse deck here is forward-only (its click
   * zones deliberately never go back, on the grounds that a mouse has a
   * keyboard) and Escape cannot leave it. Capture phase and a ref, for the two
   * reasons `presentKeys` already documents: the layer that owns keys in the
   * editor listens in the capture phase too, and the deck's own keys must not
   * change identity as it advances.
   */
  const presentKeysRef = useRef(present.keys);
  presentKeysRef.current = present.keys;
  useEffect(() => {
    if (!present.active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isBrowserReservedKey(event)) return;
      if (presentKey(event, presentKeysRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [present.active]);

  const fit = useCallback(() => setCamera(fitCamera(board, size)), [board, size]);

  /**
   * Frame the board on the first measurement, on a page switch and on a
   * rotation — and nowhere else. Refitting on every resize would throw away a
   * magnified view the moment the address bar collapsed, which on iOS is a
   * resize the user never asked for.
   */
  const fittedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!page || size.width <= 0 || size.height <= 0) return;
    // The board is part of the key because a document that finishes loading
    // after this shell mounted is the same page id at the same orientation, and
    // would otherwise keep the camera framed on the empty document it replaced.
    const key = `${page.id}:${board.width}x${board.height}:${size.width > size.height ? "landscape" : "portrait"}`;
    if (fittedKeyRef.current === key) return;
    fittedKeyRef.current = key;
    setCamera(fitCamera(board, size));
  }, [page?.id, board, size.width, size.height]);

  useEffect(() => {
    setCamera((current) => clampCameraPan(current, board, size));
  }, [board, size.width, size.height]);

  const handleTap = useCallback((clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY);
    return openLinkFromEvent({ target });
  }, []);

  const handleDoubleTap = useCallback(
    (clientX: number, clientY: number) => {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      setCamera((current) => {
        if (current.zoom < DOUBLE_TAP_READ_ZOOM) {
          return zoomCameraAt(current, x, y, DOUBLE_TAP_READ_ZOOM / current.zoom);
        }
        return fitCamera(board, size);
      });
    },
    [board, size.width, size.height]
  );

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const host = hostRef.current;
      if (!host) return false;
      const rect = host.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const worldX = (mouseX - camera.pan.x) / camera.zoom;
      const worldY = (mouseY - camera.pan.y) / camera.zoom;

      const hit = findElementAtPoint(displayElements, worldX, worldY, { includeLocked: true });
      if (hit && hit.type === "html") {
        const iframe = host.querySelector<HTMLIFrameElement>(`iframe[data-html-embed-id="${hit.id}"]`);
        if (iframe && iframe.contentWindow) {
          try {
            iframe.contentWindow.scrollBy({ left: e.deltaX, top: e.deltaY, behavior: "auto" });
          } catch {}
        }
        return true;
      }

      const candidates = findScrollableContainersAtPoint(displayElements, worldX, worldY, doc);
      if (candidates.length > 0) {
        for (const cand of candidates) {
          const curX = containerScrolls[cand.id]?.x ?? cand.scrollX ?? 0;
          const curY = containerScrolls[cand.id]?.y ?? cand.scrollY ?? 0;
          const candWithScroll = { ...cand, scrollX: curX, scrollY: curY };
          if (canContainerScroll(candWithScroll, e.deltaX, e.deltaY, doc)) {
            const { scrollX: nextX, scrollY: nextY } = clampScrollOffset(
              candWithScroll as any,
              curX + e.deltaX,
              curY + e.deltaY,
              undefined,
              doc
            );
            if (nextX !== curX || nextY !== curY) {
              setContainerScrolls((prev) => ({
                ...prev,
                [cand.id]: { x: nextX, y: nextY }
              }));
              return true;
            }
          }
        }
        const hasOverflow = candidates.some((cand) => {
          const { maxScrollX, maxScrollY } = computeContainerScrollBounds(cand, undefined, doc);
          const mode =
            cand.scrollOverflow ??
            (cand.type === "instance"
              ? findMasterComponent(doc, (cand as InstanceElement).componentId)?.scrollOverflow
              : "none");
          return (
            ((mode === "horizontal" || mode === "both") && maxScrollX > 0) ||
            ((mode === "vertical" || mode === "both") && maxScrollY > 0)
          );
        });
        if (hasOverflow) {
          return true;
        }
      }
      return false;
    },
    [camera, displayElements, containerScrolls, doc]
  );

  useViewerGestures({
    hostRef,
    camera,
    size,
    bounds: board,
    onChange: setCamera,
    onTap: handleTap,
    onDoubleTap: handleDoubleTap,
    onPanChange: setPanning,
    onWheel: handleWheel
  });

  const zoomByStep = useCallback(
    (direction: 1 | -1) => {
      setCamera((current) =>
        zoomCameraAt(current, size.width / 2, size.height / 2, zoomStep(current.zoom, direction) / current.zoom)
      );
    },
    [size.width, size.height]
  );

  const viewportBox = useMemo(() => cameraViewportBox(camera, size), [camera, size.width, size.height]);

  if (!page) return null;

  return (
    <div className="fixed inset-0 overflow-hidden bg-paper select-none">
      <ViewerStage
        hostRef={hostRef}
        page={page}
        elements={displayElements}
        allElements={allElements}
        docRef={docRef}
        camera={camera}
        viewportBox={viewportBox}
        panning={panning}
      />
      <ViewerChrome
        docName={doc.name || t("titlebar.untitled")}
        pages={pages}
        pageIndex={pageIndex}
        zoomLabel={formatZoomPercent(camera.zoom)}
        editorHref={readOnly ? null : editorHref(window.location.search, window.location.href)}
        readOnly={readOnly}
        canPresent={canPresent}
        onSelectPage={goToPage}
        onZoomIn={() => zoomByStep(1)}
        onZoomOut={() => zoomByStep(-1)}
        onFit={fit}
        onPresent={startPresent}
      />

      {present.active && (
        <PresentOverlay
          frame={present.frame}
          index={present.index}
          total={present.total}
          transition={present.transition}
          page={present.page}
          pages={present.pages}
          docRef={docRef}
          onExit={present.keys.exit}
          onNext={present.keys.next}
          onPrev={present.keys.prev}
          onSelectPage={present.selectPage}
          canvasBackground={present.page ? canvasAnswers[present.page.id] : undefined}
          onSetCanvasBackground={answerCanvasBackground}
        />
      )}
    </div>
  );
}

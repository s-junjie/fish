import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { DesignDocument, DesignElement, TextElement, PathElement, getActivePage } from "../../core/dsl/types";
import { GuideLine } from "../../core/geometry/snap-guides";
import type { TextEditRange } from "../../core/interactions/text-spans";
import { DocumentStage } from "./DocumentStage";
import { SelectionOverlay } from "./SelectionOverlay";
import { tidyBadgeReach } from "./SmartSelectionOverlay";
import { ImageCropOverlay } from "./ImageCropOverlay";
import type { GradientHandle } from "../hooks/canvas-gestures/gradient-gesture";
import type { MarqueeRect } from "../hooks/useCanvasGestures";
import type { CropCorner, CropHandle } from "../../core/geometry/image-crop";
import { useImageCropTarget } from "../hooks/image-crop-edit";
import { MeasureResult } from "../../core/geometry/measure-guides";
import { LIVE_CHROME_SELECTOR } from "../../core/chrome-markers";
import { MeasurementOverlay } from "./MeasurementOverlay";
import { GridCellOverlay } from "./GridCellOverlay";
import { SpacingOverlay } from "./SpacingOverlay";
import { SmartSelectionInfo } from "../../core/geometry/smart-selection";
import { PathEditOverlay } from "./PathEditOverlay";
import { PenDrawOverlay } from "./PenDrawOverlay";
import { PenNodeOverlay, PenTarget } from "./PenNodeOverlay";
import { ViewportBox } from "../../core/geometry/cull";
import { ShapeDraftGeometry, isSelectingTool } from "../../core/geometry/shape-creation";
import type { PenMode, ToolType } from "../../core/tools";
import { ShapeDrawOverlay } from "./ShapeDrawOverlay";
import { ASSET_MIME } from "../../core/plugins/types";
import { elementAABB } from "../../core/geometry/element-bounds";
import { findElementById, computeParentWorldMatrix, isContainer } from "../../core/geometry/tree-ops";
import { elementTransformMatrix } from "../../core/geometry/transforms";
import { matrixToSvg, multiply } from "../../core/geometry/matrix";
import { transformBoundsToAABB } from "../../core/geometry/bounds";
import { worldMatrixOf, worldShapeMatrixOf } from "../../core/interactions/component-swap";
import { openLinkFromEvent } from "../link-activation";
import { DEFAULT_CANVAS_BACKGROUND } from "../../core/dsl/defaults";
import { t } from "../../i18n";
import { CANVAS_SELECT, CANVAS_COMPONENT, CANVAS_ON_SELECT, withAlpha } from "./canvas-colors";
import { pageNeedsBackdropSafeStage } from "./stage-transform-mode";
import { MorphPairOverlay } from "./MorphPairOverlay";
import { applyBackdropLod } from "./backdrop-lod";
import { applyShadowLod } from "./shadow-lod";
import { matchSlides } from "../../core/presentation/morph";
import { presentationFrames, nextSlideOf } from "../../core/presentation/frames";
import { resolveSlide } from "../../core/presentation/slide";
import { layoutOf } from "../../core/dsl/layout-flat";
import { CommentsOverlay, type CommentsOverlayProps } from "./CommentsOverlay";

/** How long a zoom must hold before the invisible hit slop is re-sized to it. */
const HIT_ZOOM_SETTLE_MS = 100;

interface CanvasAreaProps {
  canvasContainerRef: { current: HTMLDivElement | null };
  isCanvasOnlyView?: boolean;
  shapeDraft?: ShapeDraftGeometry | null;
  doc: DesignDocument;
  allElements: DesignElement[];
  docRef: { current: DesignDocument };
  zoom: number;
  pan: { x: number; y: number };
  /** Document point to slide under the viewport's top-left in canvas-only view. */
  headlessOrigin?: { x: number; y: number } | null;
  viewportBox?: ViewportBox | null;
  isCanvasPanning: boolean;
  isPanMode: boolean;
  activeTool: string;
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  selectedElements: DesignElement[];
  primarySelected: DesignElement | null;
  multiBounds: { minX: number; minY: number; width: number; height: number } | null;
  activeGuides: GuideLine[];
  marqueeRect: MarqueeRect | null;
  measurement?: MeasureResult | null;
  smartSelection?: SmartSelectionInfo | null;
  isSmartDragActive?: boolean;
  isGapDragActive?: boolean;
  /**
   * The inspector is being used, so the selection chrome stands down until it
   * goes quiet again — it is drawn over the very value being typed.
   */
  overlaySuppressed?: boolean;
  /** True while the presentation overlay is open. Defs are withheld so their IDs do not shadow the overlay's. */
  presentActive?: boolean;
  /** Whether the pairing lines are drawn; they are known whenever a morphing
   *  slide is selected. */
  showMorphLines?: boolean;
  /** The element id of the pair whose row is hovered in the inspector. */
  morphHighlightId?: string | null;
  swapDropBox?: { x: number; y: number; width: number; height: number } | null;
  onGapDragStart?: (e: any, handleId: string) => void;
  onTidySpacing?: (axis: "x" | "y") => void;
  onDotDragStart?: (e: any, dot: any) => void;
  editingPathElement?: PathElement | null;
  selectedAnchorIdxs?: Set<number>;
  onSelectOnlyAnchor?: (idx: number) => void;
  onToggleAnchor?: (idx: number) => void;
  penMode?: PenMode;
  penTargets?: PenTarget[];
  onEditPenPath?: (id: string, newD: string) => void;
  onExitPen?: () => void;
  onCommitPathEdit?: (newD: string) => void;
  onExitPathEdit?: () => void;
  onFinishPenDraft?: (data: { x: number; y: number; width: number; height: number; d: string }) => void;
  onCancelPenDraft?: () => void;
  dragOverFrameId: string | null;
  /** Element a plain single click would select at the current pointer; outlined on hover. */
  hoverSelectId: string | null;
  /** Live preview of where a drag inside an auto-layout container will land. */
  dropSlot?: { x: number; y: number; width: number; height: number } | null;
  editingCanvasTextId: string | null;
  canvasTextDraft: string;
  setCanvasTextDraft: (s: string, edit?: TextEditRange) => void;
  canvasTextInputRef: { current: HTMLTextAreaElement | null };
  onCanvasMouseDown: (e: any) => void;
  onCanvasMouseMove: (e: any) => void;
  onWheel: (e: any) => void;
  onCanvasClick: (e: any) => void;
  onElementMouseDown: (e: any, el: DesignElement) => void;
  onResizePointerDown: (e: any, type: any, el: DesignElement) => void;
  onMultiResizePointerDown?: (e: any, type: any, ids: Set<string>) => void;
  onRotatePointerDown: (e: any, corner: any, el: DesignElement, angleOffset: number) => void;
  onEndpointPointerDown: (e: any, el: DesignElement, which: "start" | "end") => void;
  onRadiusPointerDown: (e: any, el: DesignElement) => void;
  onStartOffsetPointerDown?: (e: any, el: DesignElement) => void;
  onGradientHandlePointerDown?: (e: any, el: DesignElement, paintIndex: number, which: GradientHandle) => void;
  /**
   * Crop mode's gestures. Optional as a set: a host that mounts the canvas
   * without an editor (the canvas-only view, presentation) has no crop mode and
   * passes none, and the overlay is simply not drawn.
   */
  onCropMovePointerDown?: (e: any, el: DesignElement, paintIndex: number) => void;
  onCropHandlePointerDown?: (e: any, el: DesignElement, paintIndex: number, handle: CropHandle) => void;
  onCropRotatePointerDown?: (
    e: any,
    el: DesignElement,
    paintIndex: number,
    corner: CropCorner,
    baseAngle: number
  ) => void;
  onOnPathTextBounds?: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  onStartCanvasTextEdit: (el: TextElement) => void;
  onTextSelect?: (range: { start: number; end: number } | null) => void;
  onCommitCanvasText: () => void;
  onCancelCanvasText: () => void;
  onInsertImage?: (file: File | Blob, worldX: number, worldY: number) => void;
  onAssetDrop?: (payloadJson: string, worldX: number, worldY: number) => void;
  onPathDragStart?: () => void;
  onPathDragChange?: (newD: string) => void;
  /** Cmd/Ctrl held: the resize handles of a frame mean "resize the frame only". */
  frameResizeKey?: boolean;
  onContextMenu?: (e: any) => void;
  commentsOverlayProps?: CommentsOverlayProps | null;
}

/** Stable empties for the canvas-only branch: a fresh `new Set()` each render
 *  would defeat the renderer's memo and re-paint the whole page. */
const NO_SELECTION: Set<string> = new Set();
const noop = () => {};
const EMPTY_ANCHOR_SELECTION = new Set<number>();
const EMPTY_PEN_TARGETS: PenTarget[] = [];

export function CanvasArea({
  canvasContainerRef,
  isCanvasOnlyView,
  headlessOrigin,
  shapeDraft,
  doc,
  allElements,
  docRef,
  zoom,
  pan,
  viewportBox,
  isCanvasPanning,
  isPanMode,
  activeTool,
  selectedIds,
  setSelectedIds,
  selectedElements,
  primarySelected,
  multiBounds,
  activeGuides,
  marqueeRect,
  measurement,
  smartSelection,
  isSmartDragActive,
  isGapDragActive,
  overlaySuppressed,
  presentActive,
  showMorphLines = true,
  morphHighlightId,
  swapDropBox,
  onGapDragStart,
  onTidySpacing,
  onDotDragStart,
  editingPathElement,
  selectedAnchorIdxs,
  onSelectOnlyAnchor,
  onToggleAnchor,
  penMode = "draw",
  penTargets = EMPTY_PEN_TARGETS,
  onEditPenPath,
  onExitPen,
  onCommitPathEdit,
  onExitPathEdit,
  onFinishPenDraft,
  onCancelPenDraft,
  dragOverFrameId,
  hoverSelectId,
  dropSlot,
  editingCanvasTextId,
  canvasTextDraft,
  setCanvasTextDraft,
  canvasTextInputRef,
  onCanvasMouseDown,
  onCanvasMouseMove,
  onWheel,
  onCanvasClick,
  onElementMouseDown,
  onResizePointerDown,
  onMultiResizePointerDown,
  onRotatePointerDown,
  onEndpointPointerDown,
  onRadiusPointerDown,
  onStartOffsetPointerDown,
  onGradientHandlePointerDown,
  onCropMovePointerDown,
  onCropHandlePointerDown,
  onCropRotatePointerDown,
  onOnPathTextBounds,
  onStartCanvasTextEdit,
  onTextSelect,
  onCommitCanvasText,
  onCancelCanvasText,
  onInsertImage,
  onAssetDrop,
  onPathDragStart,
  onPathDragChange,
  frameResizeKey,
  onContextMenu,
  commentsOverlayProps
}: CanvasAreaProps) {
  const isMeasuring = Boolean(measurement);

  // Which layers of this slide become which layers of the next one, drawn while
  // the slide that MORPHS is selected. It is a reading of the document rather
  // than stored state, so a rename or a nudge updates the lines on the same
  // frame the edit lands.
  //
  // The deck order comes from `presentationFrames` — reading order, the one
  // place that decides — so "the next slide" means the one a presenter would
  // arrive on, not the one below it in the layer panel.
  // A `const` so the narrowing survives into the memo below: a destructured
  // prop is a mutable binding, and TypeScript drops a narrowing across a
  // closure boundary for one.
  const morphTarget = primarySelected && isContainer(primarySelected) ? primarySelected : null;
  const morphPairs = useMemo(() => {
    if (!morphTarget) return null;
    if (resolveSlide(morphTarget.slide).transition !== "morph") return null;
    const next = nextSlideOf(presentationFrames(doc), morphTarget.id);
    if (!next) return null;
    return {
      match: matchSlides(morphTarget, next),
      fromOrigin: { x: morphTarget.x, y: morphTarget.y },
      toOrigin: { x: next.x, y: next.y }
    };
  }, [doc, morphTarget]);

  // A resolved instance child is painted but never stored: it has no geometry to
  // transform and no sibling order to reorder, so the overlay draws its outline only.
  const transformLocked = Boolean(
    primarySelected && (primarySelected as { __instanceId?: string }).__instanceId
  );

  // Crop mode's target, resolved to a live element. The store holds ids, and a
  // layer that was deleted (or is not on the active page) simply has nothing to
  // draw chrome around — the mode is left for the selection effect to clear.
  const cropTarget = useImageCropTarget();
  const cropElement = cropTarget ? findElementById(getActivePage(doc).children, cropTarget.elId) ?? null : null;

  // The pink smart-selection affordances (reorder dots + gap pills) only show
  // while the pointer is inside the current selection, so they stop wallpapering
  // the canvas the moment a frame is picked. The container rect is cached and
  // invalidated on resize: re-measuring per move forces a synchronous layout
  // flush during element drags (see docs/LESSONS_LEARNED.md #17).
  const smartHoverBox = (() => {
    const frame = smartSelection?.parentFrame;
    // The hover test below is in canvas space, and a frame nested in another
    // container carries its own local origin — without the parent chain the test
    // ran against a box somewhere else entirely. The chain has to be the one the
    // renderer draws with: a TURNED ancestor has carried this frame, and a
    // translation named a box somewhere it never paints, so hovering the frame
    // failed to offer its gap pill.
    if (frame) {
      return transformBoundsToAABB(elementAABB(frame), worldMatrixOf(doc, frame))!;
    }
    if (multiBounds) {
      // The gate reaches past the right edge by however far the tidy-up badges do:
      // they are drawn outside the box and are the only way an unevenly spaced
      // selection becomes a spaced one, so a test that stopped at the edge would
      // take them away exactly as the pointer arrived.
      const reach = tidyBadgeReach(smartSelection?.unevenAxes.length ?? 0) / zoom;
      return {
        x: multiBounds.minX,
        y: multiBounds.minY,
        width: multiBounds.width + reach,
        height: multiBounds.height
      };
    }
    return null;
  })();
  const smartHoverKey = smartHoverBox
    ? `${smartHoverBox.x}|${smartHoverBox.y}|${smartHoverBox.width}|${smartHoverBox.height}`
    : "";

  const [smartHover, setSmartHover] = useState(false);
  const smartHoverRef = useRef(false);
  const containerRectRef = useRef<DOMRect | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const rootSvgRef = useRef<SVGSVGElement | null>(null);

  const evaluateSmartHover = (clientX: number, clientY: number) => {
    const box = smartHoverBox;
    let inside = false;
    if (box) {
      const container = canvasContainerRef.current;
      if (container && !containerRectRef.current) {
        containerRectRef.current = container.getBoundingClientRect();
      }
      const rect = containerRectRef.current;
      if (rect) {
        const worldX = (clientX - rect.left - pan.x) / zoom;
        const worldY = (clientY - rect.top - pan.y) / zoom;
        const pad = 12 / zoom;
        inside =
          worldX >= box.x - pad &&
          worldX <= box.x + box.width + pad &&
          worldY >= box.y - pad &&
          worldY <= box.y + box.height + pad;
      }
    }
    if (inside !== smartHoverRef.current) {
      smartHoverRef.current = inside;
      setSmartHover(inside);
    }
  };

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      containerRectRef.current = null;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [canvasContainerRef]);

  // A click can change the selection without any pointer movement, so the hover
  // verdict is re-derived whenever the selection box itself changes.
  useEffect(() => {
    const p = lastPointerRef.current;
    if (p) evaluateSmartHover(p.x, p.y);
  }, [smartHoverKey]);

  const handleCanvasPointerMove = (e: any) => {
    if (typeof e.clientX === "number") {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
    }
    evaluateSmartHover(e.clientX, e.clientY);
  };

  const handleDragOver = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (dt && (dt.types.includes("Files") || dt.types.includes(ASSET_MIME))) {
      e.preventDefault();
      dt.dropEffect = "copy";
    }
  };

  const handleDrop = (e: DragEvent) => {
    const assetPayload = e.dataTransfer?.getData(ASSET_MIME);
    if (assetPayload && onAssetDrop && canvasContainerRef.current) {
      e.preventDefault();
      e.stopPropagation();
      const rect = canvasContainerRef.current.getBoundingClientRect();
      const worldX = Math.round(((e.clientX - rect.left) - pan.x) / zoom);
      const worldY = Math.round(((e.clientY - rect.top) - pan.y) / zoom);
      onAssetDrop(assetPayload, worldX, worldY);
      return;
    }

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isMedia = file.type.startsWith("image/") || file.type.startsWith("video/") || /\.(png|jpe?g|webp|svg|gif|mp4|webm|ogg|mov|m4v)$/i.test(file.name || "");
      if (isMedia && onInsertImage && canvasContainerRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const rect = canvasContainerRef.current.getBoundingClientRect();
        const worldX = Math.round(((e.clientX - rect.left) - pan.x) / zoom);
        const worldY = Math.round(((e.clientY - rect.top) - pan.y) / zoom);
        onInsertImage(file, worldX, worldY);
      }
    }
  };

  const activePage = getActivePage(doc);
  const pageCanvas = activePage.canvas || doc.canvas;
  const canvasBgColor = pageCanvas.background?.type === "solid" ? pageCanvas.background.color : DEFAULT_CANVAS_BACKGROUND;

  /**
   * Which of the two places the pan/zoom is written to.
   *
   * The composited CSS `transform` on the root `<svg>` is the default and the
   * `<g data-stage-transform>` attribute is the exception: the group exists for
   * `LESSONS_LEARNED.md` #166, where Chromium drops every `backdrop-filter` in
   * the SVG once a non-`normal` `mix-blend-mode` appears AND anything above the
   * canvas moves it by transform. Neither half alone triggers it, so the question
   * is per page and answered in `stage-transform-mode.ts`. The exception costs:
   * the attribute re-rasterises the SVG where the CSS one only re-composites.
   *
   * The `<g>` is emitted in BOTH cases — `export.ts` unwraps it and 19 e2e specs
   * read coordinates off it, so only where the transform lands may differ.
   */
  const pageNeedsGroup = useMemo(
    () => pageNeedsBackdropSafeStage(activePage.children),
    [activePage.children]
  );
  const stageNeedsGroup = isCanvasOnlyView || pageNeedsGroup;

  /**
   * Where the edited path's geometry coordinates sit on the canvas.
   *
   * Memoized on the two things it reads: the overlay keys a window listener on
   * it, so handing it a fresh object per render would rebind that listener every
   * time the canvas so much as repainted.
   */
  const editingPathShapeMatrix = useMemo(
    () => (editingPathElement ? worldShapeMatrixOf(doc, editingPathElement) : null),
    [doc, editingPathElement]
  );

  const stageTransform = stageNeedsGroup
    ? isCanvasOnlyView
      ? headlessOrigin
        ? `translate(${-headlessOrigin.x}, ${-headlessOrigin.y})`
        : undefined
      : `translate(${pan.x}, ${pan.y}) scale(${zoom})`
    : undefined;

  /**
   * The zoom the root `--fish-zoom` is written at, trailing the live one.
   *
   * The variable is an INHERITED custom property, so writing it on the root
   * invalidates the computed style of every descendant — measured at 3.7 ms per
   * thousand mounted nodes (16.7 -> 33.4 ms at 17.6 k, -> 116.7 ms at 52.8 k),
   * and the cost is the descendants, not the consumers: stripping all 4,560
   * `[data-hit]` nodes still left 50 ms of it. A wheel tick cannot afford one.
   *
   * What it sizes is the hit slop, a TRANSPARENT stroke: a wheel gesture never
   * hit-tests, so a value one gesture behind is invisible. Throttling instead of
   * deferring does not work — each write still costs the same, so it turns a
   * steady 33 ms into a periodic 66 ms spike and leaves p95 untouched.
   */
  const [hitZoom, setHitZoom] = useState(zoom);
  useEffect(() => {
    if (isCanvasOnlyView || hitZoom === zoom) return;
    const settle = setTimeout(() => setHitZoom(zoom), HIT_ZOOM_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [zoom, hitZoom, isCanvasOnlyView]);

  /**
   * The chrome the same variable sizes that is PAINTED rather than invisible, and
   * so cannot wait for the settle: frame titles, component-set outlines, instance
   * placeholders. The live value is written on each of those elements instead of
   * on the root, where the invalidation stops at that element — measured free
   * (16.7 ms/frame) next to the 33.4 ms the root write costs on the same tree.
   *
   * Re-queried every tick rather than cached: culling mounts and unmounts titled
   * frames as the zoom moves, and the query itself measured free.
   */
  useLayoutEffect(() => {
    if (isCanvasOnlyView) return;
    const svg = rootSvgRef.current;
    if (!svg) return;
    for (const el of svg.querySelectorAll<SVGElement>(LIVE_CHROME_SELECTOR)) {
      el.style.setProperty("--fish-zoom", String(zoom));
    }
  }, [zoom, isCanvasOnlyView]);

  /**
   * Backdrops too small to show a blur, and shadows too small to show a reach,
   * are not painted at all — the rules and the measurements live next to their
   * numbers, in `backdrop-lod.ts` and `shadow-lod.ts`.
   *
   * No dependency list, unlike the pass above: a node that re-renders rewrites
   * its own `backdrop-filter`/`filter` from its props, which puts back one this
   * pass had turned off, and nothing else in the tree would notice. Running after
   * every render is what makes the pass idempotent rather than merely eventual.
   */
  useLayoutEffect(() => {
    if (isCanvasOnlyView) return;
    const svg = rootSvgRef.current;
    if (!svg) return;
    applyBackdropLod(svg, zoom);
    applyShadowLod(svg, zoom);
  });

  return (
    <div
      ref={canvasContainerRef}
      data-canvas-root="true"
      data-canvas-only={isCanvasOnlyView ? "true" : undefined}
      onMouseDown={
        isCanvasOnlyView
          ? undefined
          : (e: any) => {
              containerRectRef.current = null;
              onCanvasMouseDown(e);
            }
      }
      onMouseMove={
        isCanvasOnlyView
          ? undefined
          : (e: any) => {
              onCanvasMouseMove(e);
              handleCanvasPointerMove(e);
            }
      }
      onWheel={isCanvasOnlyView ? undefined : onWheel}
      onClick={
        // Canvas-only view is a VIEW of the document — an embed, a screenshot —
        // so a linked layer is live there. In the editor a click selects, and a
        // canvas that navigates out from under an edit is not editable.
        isCanvasOnlyView ? (e: any) => void openLinkFromEvent(e) : onCanvasClick
      }
      onContextMenu={isCanvasOnlyView ? undefined : onContextMenu}
      onDragOver={isCanvasOnlyView ? undefined : handleDragOver}
      onDrop={isCanvasOnlyView ? undefined : handleDrop}
      style={
        isCanvasOnlyView
          ? {
              position: "absolute",
              top: 0,
              left: 0,
              width: `${pageCanvas.width ?? 1920}px`,
              height: `${pageCanvas.height ?? 1080}px`,
              backgroundColor: canvasBgColor,
              overflow: "hidden",
              margin: 0,
              padding: 0
            }
            : {
                backgroundColor: canvasBgColor,
                contain: "layout paint"
              }
      }
      className={
        isCanvasOnlyView
          ? "relative"
          : `absolute inset-0 overflow-hidden ${
              isCanvasPanning
                ? "cursor-grabbing"
                : isPanMode
                ? "cursor-grab"
                : activeTool === "text-on-path" ||
                  activeTool === "path" ||
                  activeTool === "rect" ||
                  activeTool === "ellipse" ||
                  activeTool === "line" ||
                  activeTool === "arrow" ||
                  activeTool === "polygon" ||
                  activeTool === "star" ||
                  activeTool === "frame" ||
                  activeTool === "comment"
                ? "cursor-crosshair"
                : activeTool === "text"
                ? "cursor-text"
                : // Scale draws nothing, so the crosshair would promise a shape
                  // that will not appear; the arrow says "this grabs the selection".
                  activeTool === "scale"
                ? "cursor-default"
                : "cursor-default"
            }`
      }
    >
      <svg
        ref={rootSvgRef}
        style={
          isCanvasOnlyView
            ? {
                width: `${pageCanvas.width ?? 1920}px`,
                height: `${pageCanvas.height ?? 1080}px`,
                display: "block",
                // The canvas-only host is never zoomed, so the chrome resolves at
                // 1:1 — stated rather than inherited, because the CSS reads this
                // variable and an unset one silently means "no slop".
                "--fish-zoom": 1
              }
            : {
                overflow: "visible",
                display: "block",
                // Composited pan/zoom: one layer move per frame, no re-raster of
                // the SVG, free at every measured size. Taken whenever the page
                // has no backdrop blur to lose to #166 (see stageNeedsGroup).
                ...(stageNeedsGroup
                  ? {}
                  : {
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transformOrigin: "0 0"
                    }),
                // The one number every screen-constant chrome value in the tree
                // divides by (see the block in style.css). Written here, on the
                // root, so the hit slop re-sizes from a single property write
                // instead of asking the renderer to re-render every element —
                // and written at the SETTLED zoom, because one write costs every
                // descendant a style recalc. Painted chrome gets the live value
                // on its own element (see LIVE_CHROME_SELECTOR).
                "--fish-zoom": hitZoom
              }
        }
        className={isCanvasOnlyView ? "" : "w-full h-full pointer-events-auto"}
      >
        <g transform={stageTransform} data-stage-transform="true">
          {!presentActive && (
            <DocumentStage
              elements={activePage.children}
              allElements={allElements}
              docRef={docRef}
              zoom={isCanvasOnlyView ? 1 : zoom}
              viewportBox={isCanvasOnlyView ? null : viewportBox}
              frameTitles={!isCanvasOnlyView}
              assets={docRef.current.assets}
              selectedIds={isCanvasOnlyView ? NO_SELECTION : selectedIds}
              setSelectedIds={isCanvasOnlyView ? noop : setSelectedIds}
              activeTool={activeTool}
              dragOverFrameId={isCanvasOnlyView ? null : dragOverFrameId}
              editingCanvasTextId={editingCanvasTextId}
              canvasTextDraft={canvasTextDraft}
              setCanvasTextDraft={setCanvasTextDraft}
              canvasTextInputRef={canvasTextInputRef}
              onElementMouseDown={isCanvasOnlyView ? noop : onElementMouseDown}
              onStartCanvasTextEdit={isCanvasOnlyView ? noop : onStartCanvasTextEdit}
              onTextSelect={isCanvasOnlyView ? undefined : onTextSelect}
              onCommitCanvasText={onCommitCanvasText}
              onCancelCanvasText={onCancelCanvasText}
              onOnPathTextBounds={isCanvasOnlyView ? undefined : onOnPathTextBounds}
              editingPathId={editingPathElement ? editingPathElement.id : null}
            />
          )}

          {!isCanvasOnlyView && (
            <>
              {/* Pen: a new path in draw mode, an existing one in add / remove. */}
              {activeTool === "path" && onFinishPenDraft && onCancelPenDraft && (
                <g data-overlay="true" data-pen-mode={penMode}>
                  {penMode === "draw" || !onEditPenPath ? (
                    <PenDrawOverlay
                      zoom={zoom}
                      pan={pan}
                      containerRef={canvasContainerRef}
                      onFinishDraft={onFinishPenDraft}
                      onCancelDraft={onCancelPenDraft}
                    />
                  ) : (
                    <PenNodeOverlay
                      mode={penMode}
                      zoom={zoom}
                      pan={pan}
                      containerRef={canvasContainerRef}
                      targets={penTargets}
                      onEditPath={onEditPenPath}
                      onExit={onExitPen ?? onCancelPenDraft}
                    />
                  )}
                </g>
              )}

              {/* Vector Path Node Editing Overlay */}
              {editingPathElement && editingPathShapeMatrix && onCommitPathEdit && onExitPathEdit && (
                <g data-overlay="true" data-pen-mode={penMode}>
                  <PathEditOverlay
                    pathElement={editingPathElement}
                    zoom={zoom}
                    pan={pan}
                    shapeMatrix={editingPathShapeMatrix}
                    docRef={docRef}
                    containerRef={canvasContainerRef}
                    penMode={penMode}
                    selectedAnchorIdxs={selectedAnchorIdxs ?? EMPTY_ANCHOR_SELECTION}
                    onSelectOnlyAnchor={onSelectOnlyAnchor ?? noop}
                    onToggleAnchor={onToggleAnchor ?? noop}
                    onCommitPath={onCommitPathEdit}
                    onDragStart={onPathDragStart}
                    onDragChange={onPathDragChange}
                    onExit={onExitPathEdit}
                  />
                </g>
              )}

              {/* Real-time Shape Creation Ghost Overlay */}
              <g data-overlay="true">
                <ShapeDrawOverlay draft={shapeDraft ?? null} zoom={zoom} />
              </g>

              {/* Auto-layout drop slot: where the dragged element will land */}
              {dropSlot && (
                <g data-overlay="true" style={{ pointerEvents: "none" }}>
                  <rect
                    data-drop-slot="true"
                    x={dropSlot.x}
                    y={dropSlot.y}
                    width={dropSlot.width <= 2 ? Math.max(dropSlot.width, 2 / zoom) : dropSlot.width}
                    height={dropSlot.height <= 2 ? Math.max(dropSlot.height, 2 / zoom) : dropSlot.height}
                    fill={withAlpha(CANVAS_SELECT, 0.3)}
                    stroke={CANVAS_SELECT}
                    strokeWidth={1 / zoom}
                    rx={2 / zoom}
                  />
                </g>
              )}

              {/* Selection Box & Smart Selection Gap Handles */}
              {!isMeasuring && !overlaySuppressed && (
                <g data-overlay="true" data-selection-overlay="true">
                  <SelectionOverlay
                    doc={doc}
                    primarySelected={primarySelected}
                    selectedElements={selectedElements}
                    activeTool={activeTool}
                    zoom={zoom}
                    frameResizeKey={frameResizeKey}
                    multiBounds={multiBounds}
                    activeGuides={activeGuides}
                    marqueeRect={marqueeRect}
                    smartSelection={smartSelection}
                    isEditingPath={Boolean(editingPathElement)}
                    isEditingText={Boolean(editingCanvasTextId)}
                    transformLocked={transformLocked}
                    hideSmart={Boolean(isSmartDragActive) || transformLocked}
                    smartHoverActive={smartHover}
                    gapDragActive={Boolean(isGapDragActive)}
                    dropBox={swapDropBox}
                    onGapDragStart={onGapDragStart}
                    onTidySpacing={onTidySpacing}
                    onDotDragStart={onDotDragStart}
                    onResizePointerDown={onResizePointerDown}
                    onMultiResizePointerDown={onMultiResizePointerDown}
                    onRotatePointerDown={onRotatePointerDown}
                    onEndpointPointerDown={onEndpointPointerDown}
                    onRadiusPointerDown={onRadiusPointerDown}
                    onStartOffsetPointerDown={onStartOffsetPointerDown}
                    onGradientHandlePointerDown={onGradientHandlePointerDown}
                  />
                </g>
              )}

              {/* Crop mode. Drawn OUTSIDE the selection group and after it: the
                  group stands down for the duration (the transform box would be
                  a second set of corners for a different gesture), and crop's
                  own chrome has to sit above whatever the group still holds. */}
              {!isMeasuring && cropTarget && cropElement && onCropMovePointerDown && onCropHandlePointerDown && (
                <ImageCropOverlay
                  doc={doc}
                  el={cropElement}
                  paintIndex={cropTarget.paintIndex}
                  zoom={zoom}
                  onMovePointerDown={onCropMovePointerDown}
                  onHandlePointerDown={onCropHandlePointerDown}
                  onRotatePointerDown={onCropRotatePointerDown}
                />
              )}

              {/* The cells of a selected grid. Outside the selection group, and
                  for the same reason as the bands below: working a gap or a
                  padding takes the box and its handles off the canvas so they do
                  not jump under the numbers being read, while these outlines are
                  what makes that gesture visible at all. It stands down where
                  something else owns the canvas outright — a measurement, or a
                  crop edit, which is its own editing surface. */}
              {!isMeasuring && !cropTarget && selectedElements.length === 1 &&
                primarySelected && isContainer(primarySelected) && layoutOf(primarySelected)?.mode === "grid" && (
                  <GridCellOverlay doc={doc} frame={primarySelected} zoom={zoom} />
                )}

              {/* Live padding / margin / gap bands while a spacing value is scrubbed
                  in the inspector. Outside the selection group on purpose: that group
                  stands down for the duration of the scrub, and these bands are the
                  feedback for exactly that gesture. */}
              <SpacingOverlay doc={doc} zoom={zoom} />

              {/* Hover preview: outline what a plain single click would select. Hidden
                  for already-selected elements (the selection box already shows them). */}
              {hoverSelectId && isSelectingTool(activeTool as ToolType) && (() => {
                const hel = findElementById(allElements, hoverSelectId);
                if (!hel || hel.visible === false || selectedIds.has(hel.id)) return null;
                // The one box on the canvas still hung off a translation-only
                // origin and its own `rotate(rot)`: inside a TURNED ancestor the
                // outline landed beside the element instead of on it, which is
                // worse than showing none — it promises a click will select
                // something the pointer is not on. The matrix carries the whole
                // chain, and the rect stays at the coordinates the node stores.
                const worldM = computeParentWorldMatrix(allElements, hel.id);
                const box = elementAABB(hel);
                const sw = 1.5 / zoom;
                return (
                  <g transform={matrixToSvg(multiply(worldM, elementTransformMatrix(hel, box.x + box.width / 2, box.y + box.height / 2)))}>
                    <rect
                      x={box.x}
                      y={box.y}
                      width={box.width}
                      height={box.height}
                      fill="none"
                      stroke={CANVAS_SELECT}
                      strokeWidth={sw}
                      strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                      pointerEvents="none"
                      opacity={0.85}
                    />
                  </g>
                );
              })()}

              {/* Morph pairing — under the measurement overlay, which stays topmost. */}
              {morphPairs && showMorphLines && (
                <g data-overlay="true">
                  <MorphPairOverlay
                    pairs={morphPairs.match.pairs}
                    fromOrigin={morphPairs.fromOrigin}
                    toOrigin={morphPairs.toOrigin}
                    zoom={zoom}
                    highlightId={morphHighlightId}
                  />
                </g>
              )}

              {/* Alt / Option Distance Measurement Overlay — always topmost inside canvas */}
              {measurement && (
                <g data-overlay="true">
                  <MeasurementOverlay measurement={measurement} zoom={zoom} />
                </g>
              )}
            </>
          )}
        </g>
      </svg>
      {commentsOverlayProps && (
        <CommentsOverlay {...commentsOverlayProps} />
      )}
    </div>
  );
}

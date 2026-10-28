import { useMemo } from "preact/hooks";
import { AssetRef, DesignDocument, DesignElement, TextElement } from "../../core/dsl/types";
import { ViewportBox } from "../../core/geometry/cull";
import type { TextEditRange } from "../../core/interactions/text-spans";
import { buildOnPathGuides } from "../../core/geometry/on-path";
import { CanvasDefs } from "./CanvasDefs";
import { deviceScale, pixelScale } from "./device-scale";
import { alignStageToDeviceGrid } from "./pixel-align";
import { SvgElementRenderer } from "./SvgElementRenderer";
import { useSettledValue } from "../hooks/useSettledValue";

/**
 * How long the zoom must hold before the stage re-bakes it.
 *
 * The scale is a function of the zoom for every BAKE decision on this stage —
 * device-grid alignment, `<defs>` rung values, LOD thresholds — and its output is
 * one the renderer cannot reuse while it moves. Applied per wheel tick it
 * invalidated `<defs>` and every raster on every frame: a full rebuild to fix a
 * seam and a bake that are only visible once the canvas stops moving.
 */
const ALIGN_SETTLE_MS = 120;

export interface DocumentStageProps {
  /** What to paint: the editor passes a page, presentation passes one artboard. */
  elements: DesignElement[];
  /**
   * Every element in the document. `<defs>` needs it because instances and
   * gradients resolve against masters that may live on another page — passing
   * only `elements` here would leave a slide's instances blank.
   */
  allElements: DesignElement[];
  docRef: { current: DesignDocument };
  zoom: number;
  viewportBox?: ViewportBox | null;
  assets?: AssetRef[];
  selectedIds?: Set<string>;

  /** Editing surface. Presentation mounts this without any of it. */
  setSelectedIds?: (ids: Set<string>) => void;
  activeTool?: string;
  dragOverFrameId?: string | null;
  editingCanvasTextId?: string | null;
  canvasTextDraft?: string;
  setCanvasTextDraft?: (s: string, edit?: TextEditRange) => void;
  canvasTextInputRef?: { current: HTMLTextAreaElement | null };
  onTextSelect?: (range: { start: number; end: number } | null) => void;
  onElementMouseDown?: (e: any, el: DesignElement) => void;
  onStartCanvasTextEdit?: (el: TextElement) => void;
  onCommitCanvasText?: () => void;
  onCancelCanvasText?: () => void;
  onOnPathTextBounds?: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  editingPathId?: string | null;
  /** Off in presentation: a slide carries no editor chrome. */
  frameTitles?: boolean;
}

const NO_IDS: Set<string> = new Set();
const NO_REF: { current: HTMLTextAreaElement | null } = { current: null };
const noop = () => {};

/**
 * The document itself: `<defs>` plus the element tree, and nothing else.
 *
 * Two hosts mount this — the editor canvas and the presentation overlay — so
 * that a paint, an instance and a gradient have exactly one renderer each. The
 * pair drifted apart once before and the symptom was every gradient painting one
 * layer off, so neither host may build its own `<defs>`.
 *
 * A second mount does mean two sets of defs in one document, and every id in
 * them is derived from an element id, so the editor's copy comes first in
 * document order and a slide's `url(#…)` resolves against it. That is correct
 * today precisely because the two copies describe the same elements — which is
 * the invariant worth stating: give the two hosts different `allElements` and
 * the shadowing becomes a bug. Both hosts are handed the document's real
 * elements for that reason.
 */
export function DocumentStage({
  elements,
  allElements,
  docRef,
  zoom,
  viewportBox = null,
  assets,
  selectedIds = NO_IDS,  setSelectedIds = noop,
  activeTool = "select",
  dragOverFrameId = null,
  editingCanvasTextId = null,
  canvasTextDraft = "",
  setCanvasTextDraft = noop,
  canvasTextInputRef = NO_REF,
  onTextSelect,
  onElementMouseDown = noop,
  onStartCanvasTextEdit = noop,
  onCommitCanvasText = noop,
  onCancelCanvasText = noop,
  onOnPathTextBounds,
  editingPathId = null,
  frameTitles
}: DocumentStageProps) {
  // Derived here, not passed in. `buildOnPathGuides` exists so the path and the
  // string it reverses can never come from different answers, and that only
  // holds if BOTH halves read one map — which is not something a caller can be
  // trusted to arrange for a host it has not been written yet. The overlay
  // proved it: main added the prop to the two components, the overlay kept
  // mounting the stage without it, and every slide with reversed text on a path
  // drew its text forwards. A prop both halves need is a derivation this
  // component owns, keyed on the one input every host already passes.
  //
  // One memo for both halves, by identity rather than by value:
  // `SvgElementRenderer` compares this by reference, so rebuilding it per host
  // would re-render the whole tree on every keystroke while still looking right.
  const onPathGuides = useMemo(() => buildOnPathGuides(allElements), [allElements]);

  // The zoom every quality decision on this stage follows, trailing the live one
  // by one settle.
  //
  // Each of those decisions is a BAKE parameter, a device-grid alignment or an
  // LOD threshold — all of which only mean something once the scale has stopped —
  // and none of them is cheap to change mid-gesture. `viewScale` and `pixelScale`
  // are rung values in a memo key: crossing one throws away every gradient,
  // pattern, filter and clip that `<defs>` emits and takes the decoded bitmaps
  // with it. Measured on `demo/performance.fish.html` (Page 1, 1,841 elements), a
  // 40-step zoom churned 1,059 `<defs>` nodes in its first frames and 5.8 per
  // frame thereafter, and re-decoded ~37 bitmaps at ~3.5 ms each — for rungs the
  // user cannot see change, on frames that are already the expensive ones.
  const settledZoom = useSettledValue(zoom, ALIGN_SETTLE_MS);

  // The document, aligned to the settled zoom's device grid on every commit.
  //
  // Alignment CLONES every element whose edge moves, and at a fractional zoom
  // that is nearly all of them — applied naively it is every node's
  // `prev.el !== next.el` failing at once, which is why this used to wait for the
  // tree to hold still for `ALIGN_SETTLE_MS`.
  //
  // Waiting was what made the FIRST drag frame expensive: `atRest` flipped
  // true → false as soon as one element moved, so the stage swapped the aligned
  // tree it had been painting for the raw one, and all 1,748 elements that had
  // been cloned for the grid changed identity at once. The settle then swapped
  // back 120 ms after the drop — two full-page rewrites per gesture.
  //
  // `snapList` now caches per element, so an unchanged element hands back the
  // object the previous frame painted (see `pixel-align.ts`). Aligning every
  // commit therefore costs one WeakMap lookup per element and keeps every
  // untouched node's identity — no start-of-gesture swap, and no settle either.
  const aligned = useMemo(
    () => alignStageToDeviceGrid(elements, allElements, settledZoom),
    [elements, allElements, settledZoom]
  );

  const alignedElements = aligned.tree;
  const alignedAllElements = aligned.flat;

  return (
    <>
      <CanvasDefs
        allElements={alignedAllElements}
        viewportBox={viewportBox}
        selectedIds={selectedIds}
        viewScale={deviceScale(settledZoom)}
        pixelScale={pixelScale(settledZoom)}
        assets={assets}
        docRef={docRef}
        onPathGuides={onPathGuides}
      />
      <SvgElementRenderer
        elements={alignedElements}
        boundsElements={elements}
        selectedIds={selectedIds}
        setSelectedIds={setSelectedIds}
        docRef={docRef}
        onPathGuides={onPathGuides}
        zoom={settledZoom}
        activeTool={activeTool}
        viewportBox={viewportBox}
        dragOverFrameId={dragOverFrameId}
        editingCanvasTextId={editingCanvasTextId}
        canvasTextDraft={canvasTextDraft}
        setCanvasTextDraft={setCanvasTextDraft}
        canvasTextInputRef={canvasTextInputRef}
        onTextSelect={onTextSelect}
        onElementMouseDown={onElementMouseDown}
        onStartCanvasTextEdit={onStartCanvasTextEdit}
        onCommitCanvasText={onCommitCanvasText}
        onCancelCanvasText={onCancelCanvasText}
        onOnPathTextBounds={onOnPathTextBounds}
        editingPathId={editingPathId}
        frameTitles={frameTitles}
      />
    </>
  );
}

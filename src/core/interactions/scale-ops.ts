import { ContainerElement, DesignDocument, DesignElement, updateActivePageElements } from "../dsl/types";
import { getActivePage } from "../dsl/types";
import { containerSizesAxis, resolveAxis } from "../geometry/resolve-axis";
import { scaleSubtreeByFactor } from "../geometry/scale-geometry";
import {
  computeParentOrigin,
  elementWorldAABB,
  findParentById,
  flattenElements,
  isContainer,
  mapElements
} from "../geometry/tree-ops";

/**
 * Figma's "Scale" (K): multiply a selection's size by a factor, and take
 * everything measured in pixels of that selection with it.
 *
 * The distinction that makes this more than a resize: a resize changes the box
 * and leaves the contents laid out for the old box, so a card dragged from 360
 * wide to 720 keeps 24px padding and 16px type. A scale is the *design*
 * operation — padding, gaps, radii, stroke weights, type size and shadow blur
 * all grow with the box, so the enlarged card is the same design at a different
 * size rather than the same design stretched. Everything a plain resize would
 * strand is what `scaleSubtreeAbout` rewrites.
 */

/** The range a factor REQUEST is clamped to — a K-tool "0.5x" or a corner drag —
 *  so the result is still a layer that can be seen and clicked. An absolute box
 *  request (W/H) skips it; see `scaleElementsToSize`. */
const MIN_FACTOR = 0.01;
const MAX_FACTOR = 100;

/**
 * Where a scale grows from, as a fraction of the element's own box.
 *
 * A fraction and not pixels, because the anchor has to survive the resize it is
 * steering: a top-left anchor is `(0, 0)` and a centre anchor is `(0.5, 0.5)`
 * whatever size the element currently is. The nine values are the 3x3 grid the
 * inspector offers, in reading order.
 */
export interface ScaleAnchor {
  x: number;
  y: number;
}

export const SCALE_ANCHORS: readonly ScaleAnchor[] = [
  { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 },
  { x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.5 },
  { x: 0, y: 1 }, { x: 0.5, y: 1 }, { x: 1, y: 1 }
];

/** Figma's default: a scale grows out of the middle unless asked otherwise. */
export const DEFAULT_SCALE_ANCHOR: ScaleAnchor = { x: 0.5, y: 0.5 };

export type ScaleRefusal = "empty" | "locked" | "engine-sized" | "no-op";

/** i18n keys, so the message is translated where it is raised. */
export const SCALE_REFUSALS: Record<ScaleRefusal, string> = {
  empty: "scale.nothingSelected",
  locked: "scale.locked",
  "engine-sized": "scale.engineSized",
  "no-op": "scale.outOfRange"
};

export interface ScaleResult {
  doc: DesignDocument;
  changed: boolean;
  refusal?: ScaleRefusal;
}

export function normalizeScaleFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor));
}

/**
 * The factor half of `normalizeScaleFactor`: a value the caller failed to guard —
 * `NaN`, zero, negative — is not a scale at all, so the layer stays put. The RANGE
 * half is deliberately absent: an absolute size request is a number the user typed
 * and the box it describes is the contract, so the floor that keeps a factor input
 * honest ("this tool scales between 1% and 100x") has no business rewriting it.
 * What still stops a degenerate result is `flooredScale`'s MIN_DIMENSION, which
 * leaves the layer present rather than merely within a ratio.
 */
function sanitizeFactor(factor: number): number {
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/**
 * The ids to scale, minus any already covered by a scaled ancestor.
 *
 * `mapElements` visits every node, including inside the subtrees it is handed, so
 * a selection of a frame *and* a layer inside it would scale the layer once with
 * its frame and again on its own — 2x on 2x. Selecting a container and something
 * inside it is an ordinary thing to do, and the outer one is what the user
 * meant, so the inner id is dropped from the target set.
 */
function collectScaleTargets(elements: DesignElement[], selectedIds: Set<string>): Set<string> {
  const scale = new Set<string>();
  const walk = (list: DesignElement[], underSelected: boolean) => {
    for (const el of list) {
      const selected = selectedIds.has(el.id);
      if (selected && !underSelected && el.locked !== true) scale.add(el.id);
      if (isContainer(el)) walk(el.children || [], underSelected || selected);
    }
  };
  walk(elements, false);
  return scale;
}

/**
 * Scale each selected element by `factor` — the whole selection as one thing, so a
 * group's layers keep the arrangement they had. See `scaleElementsByFactor`.
 */
export function scaleElements(
  elements: DesignElement[],
  selectedIds: Set<string>,
  factor: number,
  anchor: ScaleAnchor = TOP_LEFT
): DesignElement[] {
  return scaleElementsByFactor(elements, selectedIds, factor, factor, anchor);
}

/** Top-left, kept explicit: a proportional scale with no anchor stated is a grow. */
const TOP_LEFT: ScaleAnchor = { x: 0, y: 0 };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Which axes this layer's own scale may write.
 *
 * An axis the layout engine owns is not this layer's to resize. `fit-content` takes
 * its size from its content and `fill` takes it from its parent, so a box written
 * there is a value the engine is about to replace: the scale appeared to work — the
 * drag moved, the type grew — and then the relayout put the box back to the measured
 * content width or the parent's width, so the one thing the user was pointing at did
 * nothing. The resize path has refused these axes since the beginning; a scale that
 * wrote them anyway was the inconsistent half of the same feature.
 *
 * An INSTANCE is the exception, and for a reason of its own: it has no children
 * this layer can reach, so its box is the only place the operation can be
 * written and the factor is what carries the contents. Refusing its axes made the
 * tool answer `engine-sized` for every instance of a hugging master — a chip, an
 * icon button, most of a design system — and that is not a limitation of the
 * model, it is a scale nobody could perform. Only the layout still outranks it:
 * a `fill` axis and a grid cell's stretch are the parent's to give.
 *
 * Per element, because siblings can disagree: a group of a `fill` row and a fixed
 * label still has an axis to scale along.
 */
export function scalableAxes(
  el: DesignElement,
  parent: ContainerElement | null
): { x: boolean; y: boolean } {
  const free = (axis: "width" | "height") =>
    resolveAxis(el, parent, axis) !== "fill" && !containerSizesAxis(el, parent, axis);
  if (el.type === "instance") return { x: free("width"), y: free("height") };
  return {
    x: resolveAxis(el, parent, "width") === "fixed",
    y: resolveAxis(el, parent, "height") === "fixed"
  };
}

/**
 * True when a scale could move this layer at all — one axis it owns is enough. Both
 * axes engine-owned means there is no box here to write, and the whole operation is
 * a no-op the user deserves to be told about rather than watch.
 */
function hasScalableAxis(elements: DesignElement[], el: DesignElement): boolean {
  const axes = scalableAxes(el, findParentById(elements, el.id));
  return axes.x || axes.y;
}

/**
 * Scale the selection by two independent factors about one anchor.
 *
 * Non-uniform because a drag is: dragging a corner changes width and height by
 * different amounts, and the properties follow each axis separately — a shadow
 * offset tracks the axes it was authored on, padding tracks the edge it belongs to.
 *
 * The anchor is a point in the SELECTION's frame, so a group keeps its internal
 * arrangement: two layers 100px apart, doubled, are 200px apart. Scaling each layer
 * about its own box instead — which is what this used to do — left the sizes right
 * and the arrangement wrong: the gap collapsed to nothing and every layer slid to the
 * top-left, so a "scale these together" moved them on top of each other. For a
 * single layer the two readings are the same arithmetic, because the selection's frame
 * is that layer's box, so this changes nothing for the case that already worked.
 */
export function scaleElementsByFactor(
  elements: DesignElement[],
  selectedIds: Set<string>,
  sx: number,
  sy: number,
  anchor: ScaleAnchor
): DesignElement[] {
  if (sx === 1 && sy === 1) return elements;
  return applyScaleFactors(
    elements,
    selectedIds,
    normalizeScaleFactor(sx),
    normalizeScaleFactor(sy),
    anchor
  );
}

function applyScaleFactors(
  elements: DesignElement[],
  selectedIds: Set<string>,
  fx: number,
  fy: number,
  anchor: ScaleAnchor
): DesignElement[] {
  const scale = collectScaleTargets(elements, selectedIds);
  if (scale.size === 0) return elements;
  const bounds = selectionWorldBounds(elements, scale);
  if (!bounds) return elements;
  const anchorWorld = {
    x: bounds.x + anchor.x * bounds.width,
    y: bounds.y + anchor.y * bounds.height
  };
  return mapElements(elements, (el) => {
    if (!scale.has(el.id)) return el;
    // A 1 on an engine-owned axis is not a smaller scale, it is the same box: the
    // factor is what the axis is multiplied by, so leaving it alone is `1`, and the
    // properties on that axis come along untouched for free.
    const axes = scalableAxes(el, findParentById(elements, el.id));
    const sized = scaleSubtreeByFactor(el, axes.x ? fx : 1, axes.y ? fy : 1, anchor);
    // The layer's PLACE in the group is the selection's frame, which its own box
    // knows nothing about. `x` is parent-local and the anchor is in world space, so
    // the vector is measured in world and handed back in local — one parent hop is
    // exactly the difference between the two.
    const origin = computeParentOrigin(elements, el.id);
    const worldX = origin.x + el.x;
    const worldY = origin.y + el.y;
    return {
      ...sized,
      x: round2(anchorWorld.x + (worldX - anchorWorld.x) * (axes.x ? fx : 1) - origin.x),
      y: round2(anchorWorld.y + (worldY - anchorWorld.y) * (axes.y ? fy : 1) - origin.y)
    };
  });
}

/**
 * Scale the selection to an absolute size, which is what a W / H field and a
 * handle drag both know at the moment they commit.
 *
 * `box` is the target for a SINGLE selection. A multi-selection is scaled by the
 * ratio its union takes, because "make these 400 wide" has no single answer for
 * three differently-sized layers — the ratio is the only reading that keeps
 * their relationship, which is the entire point of scaling them together.
 *
 * The factors this derives are NOT run through `normalizeScaleFactor`: asking a
 * W field for 1px of a 300px layer is 0.003x, and honouring it is the whole point
 * of the field — clamping it to 1% would leave the box at 3px while the input read
 * 1. The degenerate end stays guarded by MIN_DIMENSION inside `flooredScale`, and
 * a relative factor (the K tool's "0.5x", a corner drag) still takes the range,
 * because there the factor is the thing the user is reading off the screen.
 */
export function scaleElementsToSize(
  elements: DesignElement[],
  selectedIds: Set<string>,
  box: { width: number; height: number },
  anchor: ScaleAnchor = DEFAULT_SCALE_ANCHOR
): DesignElement[] {
  const bounds = selectionWorldBounds(elements, selectedIds);
  if (!bounds) return elements;
  const sx = bounds.width > 0 ? box.width / bounds.width : 1;
  const sy = bounds.height > 0 ? box.height / bounds.height : 1;
  if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6) return elements;
  return applyScaleFactors(elements, selectedIds, sanitizeFactor(sx), sanitizeFactor(sy), anchor);
}

/**
 * The bounding box of a selection in canvas space, for reporting its size before a
 * scale and for framing the canvas view on it.
 */
export function selectionWorldBounds(
  elements: DesignElement[],
  selectedIds: Set<string>
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of flattenElements(elements)) {
    if (!selectedIds.has(el.id)) continue;
    const origin = computeParentOrigin(elements, el.id);
    const box = elementWorldAABB(el, origin.x, origin.y);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The document-level entry points, mirroring `fitFrameInDocument` so a
 * context-menu item, an inspector control and a canvas drag cannot disagree about
 * what a scale does.
 *
 * A refusal is a field rather than a silent `changed: false`, so the caller can
 * say why (LESSONS §15) instead of leaving the user wondering whether the
 * shortcut registered.
 */
export function scaleSelectionInDocument(
  doc: DesignDocument,
  selectedIds: Set<string>,
  factor: number
): ScaleResult {
  return runScale(doc, selectedIds, (elements, ids) => scaleElements(elements, ids, factor));
}

export function scaleSelectionToSizeInDocument(
  doc: DesignDocument,
  selectedIds: Set<string>,
  box: { width: number; height: number },
  anchor: ScaleAnchor = DEFAULT_SCALE_ANCHOR
): ScaleResult {
  return runScale(doc, selectedIds, (elements, ids) => scaleElementsToSize(elements, ids, box, anchor));
}

function runScale(
  doc: DesignDocument,
  selectedIds: Set<string>,
  apply: (elements: DesignElement[], ids: Set<string>) => DesignElement[]
): ScaleResult {
  const elements = getActivePage(doc).children;
  const selected = flattenElements(elements).filter((el) => selectedIds.has(el.id));
  if (selected.length === 0) return { doc, changed: false, refusal: "empty" };
  if (selected.every((el) => el.locked === true)) return { doc, changed: false, refusal: "locked" };
  // Checked before applying, because the apply's own no-op answer is indistinguishable
  // from a factor that landed outside the legal range: both leave the tree untouched.
  // This way the tool can say which one it was instead of reporting the wrong reason.
  if (selected.every((el) => !hasScalableAxis(elements, el)))
    return { doc, changed: false, refusal: "engine-sized" };
  const next = apply(elements, selectedIds);
  if (next === elements) return { doc, changed: false, refusal: "no-op" };
  return { doc: updateActivePageElements(doc, next), changed: true };
}

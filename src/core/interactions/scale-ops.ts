import { ContainerElement, DesignDocument, DesignElement, updateActivePageElements } from "../dsl/types";
import { getActivePage } from "../dsl/types";
import { relayoutDocumentTree } from "../compile";
import { instanceSizeResolver } from "./instance-size";
import { containerSizesAxis, resolveAxis } from "../geometry/resolve-axis";
import type { ResizeHandleType } from "../geometry/snap-guides";
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

/**
 * Where a HANDLE drag grows from: the point opposite the handle, which is the one
 * the pointer is not holding. A drag is a statement about an edge, so the opposite
 * edge is what must not move — a centre anchor there makes the grabbed edge travel
 * at half the pointer's speed and slides the layer out from under it. The panel's
 * anchor picker governs panel edits, which have no handle to disagree with.
 */
export const ANCHOR_FROM_HANDLE: Record<ResizeHandleType, ScaleAnchor> = {
  br: { x: 0, y: 0 },
  tr: { x: 0, y: 1 },
  bl: { x: 1, y: 0 },
  tl: { x: 1, y: 1 },
  mr: { x: 0, y: 0.5 },
  ml: { x: 1, y: 0.5 },
  bm: { x: 0.5, y: 0 },
  tm: { x: 0.5, y: 1 }
};

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
 * One axis the layout engine truly owns is `fill` (and a grid cell's stretch): the
 * box comes from the parent, and nothing this layer does can change what the parent
 * hands it. That axis is refused.
 *
 * A `fit-content` / `max-content` axis is NOT out of reach, and treating it as if it
 * were is what made the tool unusable where it matters most. The engine does not
 * invent that size, it MEASURES the content — and a scale is exactly the operation
 * that scales the content: type size, padding, gaps, radii, the children's own
 * boxes. A 16px label doubled measures itself at 32px, so the box the relayout
 * writes back is the doubled one. Refusing the axis produced the opposite: an Auto
 * Width text had no handle at all and the panel answered `engine-sized`, and a
 * half-hugging component scaled in one direction only, which left a circle squashed
 * into an ellipse and its type at 1x.
 *
 * An INSTANCE keeps its old reason for being free: it has no children this layer can
 * reach, so its box is the only place the operation can be written and the factor is
 * what carries the contents.
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
  return { x: free("width"), y: free("height") };
}

/**
 * Which axes a scale of this SELECTION can write, for the panel that has to
 * report a factor back.
 *
 * Per element the answer is `scalableAxes`; a union takes the union of them,
 * because one layer with a free width still moves the selection's width. A
 * selection where NO layer owns an axis is the case worth naming: every layer is
 * `fill` (or stretched by its parent), so that axis reads back unchanged however
 * far the other one travelled.
 */
export function selectionScalableAxes(
  elements: DesignElement[],
  selectedIds: Set<string>
): { x: boolean; y: boolean } {
  let x = false;
  let y = false;
  for (const el of flattenElements(elements)) {
    if (!selectedIds.has(el.id)) continue;
    const axes = scalableAxes(el, findParentById(elements, el.id));
    if (axes.x) x = true;
    if (axes.y) y = true;
  }
  return { x, y };
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
  // A pair of 1s is not a tiny scale, it is no scale — and saying so here keeps
  // the ARRAY identity, which is what tells `runScale` the answer is a no-op
  // rather than a rewrite that happened to land on the same numbers. Without it
  // a W field handed `0` (which `sanitizeFactor` reads as "use 1") came back as
  // a fresh tree, so `changed` was true and a refusal was turned into an edit.
  if (fx === 1 && fy === 1) return elements;
  const scale = collectScaleTargets(elements, selectedIds);
  if (scale.size === 0) return elements;
  const bounds = selectionWorldBounds(elements, scale);
  if (!bounds) return elements;
  const anchorWorld = {
    x: bounds.x + anchor.x * bounds.width,
    y: bounds.y + anchor.y * bounds.height
  };
  // One layer is its own selection: its box IS the frame the anchor is a fraction
  // of, so the placement answer is local and needs no world round-trip. The
  // round-trip is what broke a ROTATED layer — it measured the box against the
  // axis-aligned bounds the rotation projects onto, and put the layer where a
  // box of that silhouette would go.
  const sole = scale.size === 1 ? [...scale][0] : null;
  return mapElements(elements, (el) => {
    if (!scale.has(el.id)) return el;
    // A 1 on an engine-owned axis is not a smaller scale, it is the same box: the
    // factor is what the axis is multiplied by, so leaving it alone is `1`, and the
    // properties on that axis come along untouched for free.
    const axes = scalableAxes(el, findParentById(elements, el.id));
    const sized = scaleSubtreeByFactor(el, axes.x ? fx : 1, axes.y ? fy : 1, anchor, axes);
    if (sole === el.id && el.type !== "line") {
      // A line turns about its ORIGIN, not its centre, so the pin below does not
      // describe it; it keeps the world-bounds placement.
      const pinned = originHoldingAnchor(el, sized.width, sized.height, anchor);
      return { ...sized, x: pinned.x, y: pinned.y };
    }
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
 * Where a scaled box has to sit for the anchor it grew from to stay on the same
 * point on screen.
 *
 * Rotation turns about the box CENTRE (`elementPivot`), so the centre is the one
 * point a turn cannot move and every other point travels along an arc. Holding a
 * rotated box's top-left fixed in its parent's coordinates would therefore leave
 * the turn to swing that corner around the new centre — the box grows to the
 * right size, so the new centre is `C + L(d) − L(d′)`: `L` is the element's own
 * mirror-then-turn and `d` / `d′` the anchor's offset from the centre before and
 * after.
 *
 * With nothing to turn or mirror `L` is the identity and this reduces to the
 * placement `scaleSubtreeByFactor` writes, which is why the caller does not
 * branch on rotation.
 */
function originHoldingAnchor(
  el: DesignElement,
  width: number,
  height: number,
  anchor: ScaleAnchor
): { x: number; y: number } {
  const rad = ((el.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const flipX = el.flipX ? -1 : 1;
  const flipY = el.flipY ? -1 : 1;
  const turn = (dx: number, dy: number) => {
    const mx = dx * flipX;
    const my = dy * flipY;
    return { x: mx * cos - my * sin, y: mx * sin + my * cos };
  };
  const before = turn((anchor.x - 0.5) * el.width, (anchor.y - 0.5) * el.height);
  const after = turn((anchor.x - 0.5) * width, (anchor.y - 0.5) * height);
  return {
    x: round2(el.x + el.width / 2 + before.x - after.x - width / 2),
    y: round2(el.y + el.height / 2 + before.y - after.y - height / 2)
  };
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
  const targets = collectScaleTargets(elements, selectedIds);
  if (targets.size === 0) return elements;
  const bounds = selectionWorldBounds(elements, targets);
  if (!bounds) return elements;
  // One layer's W / H are its OWN box, not the axis-aligned box its rotation
  // projects onto: a 45° 100×50 rect measures 106×106 to the world, and typing
  // "200" into W has to produce a 200-wide rect rather than a 200-wide
  // silhouette of one. The drag path derives its factors from the layer's own
  // size for the same reason (`geometry-gestures`), and a rotated layer must not
  // answer the two tools differently.
  const sole = targets.size === 1 ? flattenElements(elements).find((el) => targets.has(el.id)) : undefined;
  const sx = sole && sole.width > 0 ? box.width / sole.width : bounds.width > 0 ? box.width / bounds.width : 1;
  const sy = sole && sole.height > 0 ? box.height / sole.height : bounds.height > 0 ? box.height / bounds.height : 1;
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
 * The factor the Scale panel should report, given the size the selection had
 * when the tool opened and the size it has now.
 *
 * The panel has two numbers to read and only one of them is a statement about
 * the scale that happened. An axis the layout engine owns — `fill`, a stretched
 * cross axis — cannot be written by this layer at all, so its ratio is 1 for
 * every scale: reporting it puts the field back at "1x" the moment a 2x scale
 * lands, and the preset tick vanishes with it. The readable axis is the one
 * `scalableAxes` said the tool could move.
 *
 * `uniform` is only a claim about two axes when both of them could move; a
 * one-axis scale is not a "non-uniform" one.
 */
export function scaleReadout(
  axes: { x: boolean; y: boolean } | null,
  reference: { width: number; height: number } | null,
  bounds: { width: number; height: number } | null
): { factor: number; uniform: boolean } {
  const widthFactor = reference && reference.width > 0 && bounds ? bounds.width / reference.width : 1;
  const heightFactor = reference && reference.height > 0 && bounds ? bounds.height / reference.height : 1;
  const factor = axes && !axes.x ? heightFactor : widthFactor;
  const uniform = !axes || !(axes.x && axes.y) || Math.abs(widthFactor - heightFactor) < 0.005;
  return { factor, uniform };
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

/**
 * Settle a document a scale just rewrote: the layout pass, measured against the
 * masters THIS document holds.
 *
 * The two must be the same document. `relayoutDocumentTree` falls back to the
 * resolver the store published on its last commit, which describes the document
 * from BEFORE this scale — so a scale that resizes a master and one of its
 * instances in the same action would measure the instance against the master it
 * used to be, and write that stale box into the tree the panel and the selection
 * outline read. The resolver's contract already says an explicit argument wins
 * for exactly this reason.
 *
 * A scale is discrete (the panel's fields) or per-frame (a drag), but it always
 * needs this one pass: it writes sizes the engine can only derive — a
 * `fit-content` text's width, a hugging frame's height, a `fill` child's box —
 * and without it the stored tree holds a number the next relayout replaces.
 */
export function settleScaledDocument(doc: DesignDocument): DesignDocument {
  return updateActivePageElements(
    doc,
    relayoutDocumentTree(getActivePage(doc).children, instanceSizeResolver(doc))
  );
}

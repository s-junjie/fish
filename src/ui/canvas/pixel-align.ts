import { DesignElement } from "../../core/dsl/types";
import { childrenOf } from "../../core/geometry/tree-query";

/**
 * Element geometry aligned to the device-pixel grid, for the canvas at `zoom`.
 *
 * The canvas draws in document units and the browser magnifies the whole stage
 * with one CSS `scale(zoom)` (CanvasArea). At a fractional zoom, an edge shared
 * by two stacked fills lands mid-pixel, and Chromium antialiases each fill on
 * its own: the top fill's coverage in that boundary row comes out a fraction
 * short of the bottom's, and the bottom shows through as a one-pixel seam. A
 * photo under a same-edge gradient overlay is the canonical case — the sky
 * ghosts a cool hairline above the fade. Export never showed it because the
 * export path rasterises at an integer scale, where the shared edge is exact.
 *
 * The fix is to make the shared edge land on a whole pixel: round every edge of
 * every element to the zoom grid, in ABSOLUTE document coordinates. Local
 * snapping is not enough — a child is positioned against its parent's origin,
 * so each level rounding on its own leaves the composed position fractional
 * (292 inside a frame at 57 is 349 on the page, and 349 × zoom is the number
 * that has to be whole). Coincident edges then round to the same pixel and the
 * two fills' antialiasing cancels. Nothing moves by more than half a pixel, and
 * at an integer zoom — or in the headless host, which is never zoomed — this is
 * the identity.
 *
 * What is deliberately NOT snapped, and why:
 *
 * - Text boxes keep their size. The box width is a layout measure: shaving half
 *   a pixel off it can re-wrap a line that exactly fit. Position still snaps.
 * - Instance and component subtrees keep their geometry entire. An instance
 *   paints its master's children through a different renderer that never sees
 *   this pass, and `<defs>` are built from the same tree here — snapping one
 *   and not the other would put a clip half a pixel off the content it clips.
 * - A rotated or flipped frame's children keep theirs. Child coordinates are
 *   expressed in the parent's rotated space, which this walk does not model.
 *
 * Both entry points preserve identity when nothing moved — the renderers
 * compare `elements` by reference, so a pan (same tree, same zoom) must hand
 * back the very array it was given or every node re-renders per frame.
 */

/** Round a document coordinate onto the zoom grid: `round(v * zoom) / zoom`. */
function snapToZoomGrid(v: number, zoom: number): number {
  return Math.round(v * zoom) / zoom;
}

/** Every id inside `root`'s subtree, root included. */
function markSubtree(root: DesignElement, out: Set<string>): void {
  out.add(root.id);
  for (const child of childrenOf(root)) markSubtree(child, out);
}

/**
 * Ids this pass must leave alone: everything under an instance or a component
 * master, at any depth. See the file comment for why those subtrees are exempt.
 */
function collectExcluded(els: DesignElement[], out: Set<string>): Set<string> {
  for (const el of els) {
    if (el.type === "instance" || el.type === "component") {
      for (const child of childrenOf(el)) markSubtree(child, out);
    }
    collectExcluded(childrenOf(el), out);
  }
  return out;
}

interface SnapEntry {
  zoom: number;
  result: DesignElement;
}

/**
 * One element's snapped result, keyed on the element itself.
 *
 * A parent's snapped origin `nx = round(ax * zoom) / zoom` is ON the grid, so
 * `nx * zoom` is whole and a child's snapped LOCAL box is the same number for
 * every parent origin:
 *
 *   round((nx + child.x) * zoom) / zoom - nx  ===  round(child.x * zoom) / zoom
 *
 * which is what lets this cache ignore the origin it was reached from. The walk
 * can therefore re-run on every commit — a drag replaces the page array and the
 * dragged element, nothing else — and the untouched elements come back as the
 * very objects the previous frame painted, so their nodes and defs hit their
 * memos. Without it a single moved element re-snapped all 1,841.
 *
 * One entry per element is all it takes: the answer depends on the element and
 * the zoom alone. An element under an instance or a component master never
 * reaches this function — `snapList` returns those as they are — so an exempt
 * subtree can neither read nor poison it.
 */
const snappedByElement = new WeakMap<DesignElement, SnapEntry>();

function snapElement(el: DesignElement, zoom: number, excluded: Set<string>): DesignElement {
  const cached = snappedByElement.get(el);
  if (cached && cached.zoom === zoom) return cached.result;

  const ax = el.x;
  const ay = el.y;
  const nx = snapToZoomGrid(ax, zoom);
  const ny = snapToZoomGrid(ay, zoom);
  const x = nx;
  const y = ny;
  const keepSize = el.type === "text" || el.type === "instance";
  const width = keepSize ? el.width : snapToZoomGrid(ax + el.width, zoom) - nx;
  const height = keepSize ? el.height : snapToZoomGrid(ay + el.height, zoom) - ny;
  const moved = x !== el.x || y !== el.y || width !== el.width || height !== el.height;
  const children = childrenOf(el);
  let snappedChildren: DesignElement[] | null = null;
  if (
    children.length > 0 &&
    (el.type === "frame" || el.type === "component") &&
    !el.rotation &&
    !el.flipX &&
    !el.flipY
  ) {
    snappedChildren = snapList(children, zoom, excluded);
  }
  const result: DesignElement =
    moved || snappedChildren
      ? snappedChildren
        ? ({ ...el, x, y, width, height, children: snappedChildren } as DesignElement)
        : ({ ...el, x, y, width, height } as DesignElement)
      : el;
  snappedByElement.set(el, { zoom, result });
  return result;
}

/**
 * The walk itself. Returns a new list, or `null` when nothing moved — the
 * callers turn `null` into the array they were given, which is what keeps a pan
 * and an unchanged commit free.
 */
function snapList(els: DesignElement[], zoom: number, excluded: Set<string>): DesignElement[] | null {
  let changed = false;
  const out: DesignElement[] = [];
  for (const el of els) {
    const next = excluded.has(el.id) ? el : snapElement(el, zoom, excluded);
    if (next !== el) changed = true;
    out.push(next);
  }
  return changed ? out : null;
}

interface AlignCache {
  zoom: number;
  result: DesignElement[];
}

const treeCache = new WeakMap<DesignElement[], AlignCache>();
const flatCache = new WeakMap<DesignElement[], AlignCache>();

/**
 * Align a rendered tree — a page's children, or one artboard — to the grid.
 *
 * This is what the renderer paints, so it is the half that removes the seam.
 */
export function alignTreeToDeviceGrid(elements: DesignElement[], zoom: number): DesignElement[] {
  if (!zoom || zoom === 1 || elements.length === 0) return elements;
  const hit = treeCache.get(elements);
  if (hit && hit.zoom === zoom) return hit.result;
  const aligned = snapList(elements, zoom, collectExcluded(elements, new Set())) ?? elements;
  treeCache.set(elements, { zoom, result: aligned });
  return aligned;
}

/**
 * Align the flat all-elements list `<defs>` resolves against, so a clip path, a
 * gradient box and a pattern tile describe the same geometry the tree paints.
 *
 * The flat list has no tree shape — every entry carries its parent-local
 * coordinates — so the alignment has to be recovered from it: the roots are the
 * entries nobody lists as a child, and the walk from there is the tree walk.
 * Entries under an exempt subtree are left untouched, which is the same answer
 * the tree walk gives, so the two never disagree about one element.
 */
export function alignFlatToDeviceGrid(flat: DesignElement[], zoom: number): DesignElement[] {
  if (!zoom || zoom === 1 || flat.length === 0) return flat;
  const hit = flatCache.get(flat);
  if (hit && hit.zoom === zoom) return hit.result;
  const childIds = new Set<string>();
  for (const el of flat) for (const child of childrenOf(el)) childIds.add(child.id);
  const roots = flat.filter((el) => !childIds.has(el.id));
  const alignedRoots = snapList(roots, zoom, collectExcluded(flat, new Set()));
  let result = flat;
  if (alignedRoots) {
    const byId = new Map<string, DesignElement>();
    const collect = (el: DesignElement): void => {
      byId.set(el.id, el);
      for (const child of childrenOf(el)) collect(child);
    };
    for (const el of alignedRoots) collect(el);
    result = flat.map((el) => byId.get(el.id) ?? el);
  }
  flatCache.set(flat, { zoom, result });
  return result;
}

export interface StageAlignment {
  /** The tree the renderer paints. */
  tree: DesignElement[];
  /** The flat list `<defs>` resolves against, aligned to the same grid. */
  flat: DesignElement[];
}

interface StageCache {
  zoom: number;
  flat: DesignElement[];
  result: StageAlignment;
}

const stageCache = new WeakMap<DesignElement[], StageCache>();

/**
 * Both halves of the stage, from ONE walk.
 *
 * `alignTreeToDeviceGrid` and `alignFlatToDeviceGrid` are handed the same tree —
 * the renderer's and `<defs>`'s views of it — so aligning them separately walked
 * all 1,841 elements twice and recovered the flat list's tree shape (roots, then
 * a by-id map) to reach an answer the first walk already had. Measured on Page 1
 * at a fractional zoom: 2.74 ms per settle, of which 1.97 ms was the second walk.
 *
 * Deriving the flat half from the tree result also makes "the two halves agree"
 * a fact about the data rather than a property of two call sites — which is what
 * the module exists to guarantee, and what a clip or pattern tile depends on.
 *
 * Identity is preserved for every element the walk left alone, so a `<defs>` memo
 * and a node memo that compare by reference still hit.
 */
export function alignStageToDeviceGrid(
  elements: DesignElement[],
  flat: DesignElement[],
  zoom: number
): StageAlignment {
  if (!zoom || zoom === 1) return { tree: elements, flat };
  const hit = stageCache.get(elements);
  if (hit && hit.zoom === zoom && hit.flat === flat) return hit.result;

  const tree = alignTreeToDeviceGrid(elements, zoom);
  const result: StageAlignment =
    tree === elements ? { tree, flat } : { tree, flat: remapFlat(flat, tree) };
  stageCache.set(elements, { zoom, flat, result });
  return result;
}

/** The flat list with each entry swapped for the aligned element of that id. */
function remapFlat(flat: DesignElement[], tree: DesignElement[]): DesignElement[] {
  const byId = new Map<string, DesignElement>();
  const collect = (el: DesignElement): void => {
    byId.set(el.id, el);
    for (const child of childrenOf(el)) collect(child);
  };
  for (const el of tree) collect(el);
  return flat.map((el) => byId.get(el.id) ?? el);
}

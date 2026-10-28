import { Rect } from "./bounds";
import { DesignElement, ContainerElement, TextElement } from "../dsl/types";
import { subtreeBounds } from "./element-bounds";

export interface ViewportBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Calculates current visible viewport bounding box in world canvas coordinates.
 */
export function calculateVisibleViewport(
  pan: { x: number; y: number },
  zoom: number,
  containerWidth: number,
  containerHeight: number,
  bufferPx = 200
): ViewportBox {
  const buffer = bufferPx / zoom;
  const x = -pan.x / zoom - buffer;
  const y = -pan.y / zoom - buffer;
  const width = containerWidth / zoom + buffer * 2;
  const height = containerHeight / zoom + buffer * 2;

  return { x, y, width, height };
}

/**
 * Checks whether an element's AABB overlaps with the visible viewport.
 */
export function isElementInViewport(elBox: Rect, vp: ViewportBox): boolean {
  return !(
    elBox.x + elBox.width < vp.x ||
    elBox.x > vp.x + vp.width ||
    elBox.y + elBox.height < vp.y ||
    elBox.y > vp.y + vp.height
  );
}

export function areViewportBoxesEqual(
  a: ViewportBox | null | undefined,
  b: ViewportBox | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The static half of the cull: which elements are roots, which subtree each one
 * owns, and which paint outside their own box regardless of the viewport.
 *
 * It is a function of the TREE, not of the camera, and the tree is shared
 * structurally — a pan hands back the same element array — so rebuilding it per
 * frame allocates a 1,841-entry parent map and a filtered roots list to answer a
 * question whose answer has not moved. Keyed on the array identity, the same
 * invariant `worldSubtreeBounds` and `flattenElements` already rely on.
 */
interface CullTopology {
  ids: Set<string>;
  roots: DesignElement[];
  /** Root id → every id in its subtree, root included. */
  byRoot: Map<string, string[]>;
  /** Masks and on-path text: the renderer keeps painting these anywhere. */
  alwaysVisible: string[];
}

const topologyCache = new WeakMap<DesignElement[], CullTopology>();

function onPathOf(el: DesignElement): boolean {
  return Boolean((el as TextElement).onPath?.pathId);
}

function topologyOf(allElements: DesignElement[]): CullTopology {
  const hit = topologyCache.get(allElements);
  if (hit) return hit;

  const ids = new Set<string>();
  const childIds = new Set<string>();
  const alwaysVisible: string[] = [];
  for (const el of allElements) {
    ids.add(el.id);
    if (el.isMask === true || onPathOf(el)) alwaysVisible.push(el.id);
    for (const child of (el as ContainerElement).children || []) childIds.add(child.id);
  }
  const roots = allElements.filter((el) => !childIds.has(el.id));

  const byRoot = new Map<string, string[]>();
  const collect = (el: DesignElement, out: string[]) => {
    out.push(el.id);
    for (const child of (el as ContainerElement).children || []) collect(child, out);
  };
  for (const root of roots) {
    const owned: string[] = [];
    collect(root, owned);
    byRoot.set(root.id, owned);
  }

  const topology = { ids, roots, byRoot, alwaysVisible };
  topologyCache.set(allElements, topology);
  return topology;
}

/**
 * Decides which flattened elements need their <defs> emitted (gradients, image
 * patterns, filters, clips). A def is only reachable through a rendered element.
 *
 * The renderer only culls TOP-LEVEL elements (SvgElementRenderer): once a top-level
 * element passes the viewport test it paints its ENTIRE subtree, so every descendant's
 * defs must be emitted whenever that top-level ancestor is in view. We therefore gate
 * by the world bounds of each element's top-level ancestor — never by the element's own
 * (local) subtree bounds. `subtreeBounds` returns coordinates in the element's local
 * space, so comparing it directly to the world `viewportBox` mis-culls nested elements:
 * a frame placed away from the origin keeps rendering while its nested image/gradient
 * defs get dropped, making those fills vanish (then reappear as you zoom/pan the origin
 * through the viewport).
 *
 * `allElements` is the flattened tree. Selected elements and mask stencils stay because
 * the renderer keeps painting those outside the viewport.
 */
export function computeVisibleElementIds(
  allElements: DesignElement[],
  viewportBox: ViewportBox | null | undefined,
  selectedIds: Set<string>
): Set<string> {
  if (!viewportBox) return new Set(allElements.map((el) => el.id));

  const topology = topologyOf(allElements);
  const visible = new Set<string>();

  for (const root of topology.roots) {
    // A root has no parent offset, so its subtree bounds are already world-space.
    if (
      selectedIds.has(root.id) ||
      root.isMask === true ||
      // Glyphs of an on-path text paint along the target path, far away from
      // the element's own stored box — a box-based viewport test would cull
      // visible text (and then it could never be measured back either).
      onPathOf(root) ||
      isElementInViewport(subtreeBounds(root), viewportBox)
    ) {
      for (const id of topology.byRoot.get(root.id)!) visible.add(id);
    }
  }

  for (const id of topology.alwaysVisible) visible.add(id);
  for (const id of selectedIds) {
    if (topology.ids.has(id)) visible.add(id);
  }
  return visible;
}


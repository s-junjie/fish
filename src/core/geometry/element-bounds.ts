import { DesignElement, ContainerElement } from "../dsl/types";
import { Rect, transformBoundsToAABB } from "./bounds";
import { isContainer } from "./tree-ops";
import { identityMatrix, multiply, transformPoint, translation, type Matrix2D } from "./matrix";
import { elementPivot, elementTransformMatrix, type TransformableBox } from "./transforms";

export type LineElementLike = Extract<DesignElement, { type: "line" | "arrow" }>;

/**
 * Line/arrow geometry invariant: `(x, y)` is the FIRST endpoint; the SECOND
 * is `(x + dx, y + dy)`. `width` / `height` are `|dx|` / `|dy|`, so any AABB
 * question about a line must go through `elementAABB`, never `(x, y, width, height)`.
 */
export function isLineElement(el: DesignElement): el is LineElementLike {
  return el.type === "line" || el.type === "arrow";
}

export function elementAABB(el: DesignElement): Rect {
  if (isLineElement(el)) {
    const x2 = el.x + el.dx;
    const y2 = el.y + el.dy;
    return {
      x: Math.min(el.x, x2),
      y: Math.min(el.y, y2),
      width: Math.abs(el.dx),
      height: Math.abs(el.dy)
    };
  }
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

/**
 * `|cos θ|` / `|sin θ|` of an element's own turn, the two coefficients that mix
 * its stored sizes into the envelope it paints.
 *
 * A BOX's mix only. A line turns about its ORIGIN (`elementPivot`), so its
 * envelope is the turned SEGMENT and no pair of coefficients reaches it —
 * `envelopeOf` takes the line branch instead. Asked of a line anyway this gives
 * the identity mix, which reserves the stored box: the safe wrong answer, and a
 * caller that wanted the segment is visible as a caller that did not get one.
 */
export function turnMixOf(el: TransformableBox): [number, number] {
  if (isLineElement(el as DesignElement)) return [1, 0];
  const rad = ((el.rotation || 0) * Math.PI) / 180;
  return [Math.abs(Math.cos(rad)), Math.abs(Math.sin(rad))];
}

/**
 * The envelope a turned box covers. The two sizes trade into each other, so a
 * long thin bar turned 45° covers an envelope NARROWER than its own width.
 *
 * The sizes are arguments because they are not always the stored ones: a hugging
 * instance is painted at its master's size, and a pass measures a text child at
 * the size it just measured.
 */
export function rotatedSize(
  width: number,
  height: number,
  mix: [number, number]
): { width: number; height: number } {
  const [c, s] = mix;
  return { width: width * c + height * s, height: width * s + height * c };
}

/**
 * Where an element paints once turned: the extent of the envelope it covers, and
 * where that envelope's corner sits relative to the anchor the document stores
 * (`el.x`, `el.y`).
 *
 * The offset is the reason both come back together. A pass decides where the
 * ENVELOPE goes, and the anchor is not the envelope's corner — for a box it sits
 * half the overhang further in, and for a line it sits wherever the turned
 * segment happens to start. To put the envelope at `(X, Y)`, write the element at
 * `(X - left, Y - top)`.
 *
 * The sizes are arguments because they are not always the stored ones: a hugging
 * instance is painted at its master's size, and a pass measures a text child at
 * the size it just measured.
 */
export interface Envelope {
  width: number;
  height: number;
  /** The envelope's left edge, measured from the element's stored `x`. */
  left: number;
  /** The envelope's top edge, measured from the element's stored `y`. */
  top: number;
}

export function envelopeOf(el: DesignElement, width: number, height: number): Envelope {
  if (isLineElement(el)) {
    // A line turns about its ORIGIN (`elementPivot`), so what it paints is the
    // turned SEGMENT — not a rectangle centred on anything. Its two axes can
    // cancel: a diagonal turned onto its own direction covers no width at all
    // while its stored `|dx|` is untouched. The direction is the segment's and
    // the sizes only its magnitude, because `placeChildAt` scales `dx`/`dy` and
    // keeps their signs.
    const rad = ((el.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const u = (el.dx >= 0 ? width : -width) * cos - (el.dy >= 0 ? height : -height) * sin;
    const v = (el.dx >= 0 ? width : -width) * sin + (el.dy >= 0 ? height : -height) * cos;
    return { width: Math.abs(u), height: Math.abs(v), left: Math.min(0, u), top: Math.min(0, v) };
  }
  const env = rotatedSize(width, height, turnMixOf(el));
  // The turn is about the box's own centre, so the envelope hangs symmetrically
  // off it — half the overhang on each side.
  return {
    width: env.width,
    height: env.height,
    left: (width - env.width) / 2,
    top: (height - env.height) / 2
  };
}

export function elementRotatedAABB(el: DesignElement): Rect {
  const base = elementAABB(el);
  if (!(el.rotation || 0)) return base;
  const env = envelopeOf(el, base.width, base.height);
  return { x: el.x + env.left, y: el.y + env.top, width: env.width, height: env.height };
}

/**
 * Union of an element's own AABB and every descendant's. A frame with
 * `clipContent: false` can paint children outside its own box, so culling must
 * test the subtree — testing the frame alone makes overflowing children vanish
 * whenever the frame itself leaves the viewport. Cached by element identity.
 */
const subtreeBoundsCache = new WeakMap<DesignElement, Rect>();

/**
 * Union of an element's own AABB and every descendant's, expressed in the
 * element's **local** coordinate space (i.e. relative to its own parent).
 *
 * For culling and gradient purposes, the caller must add the parent origin
 * chain themselves (see `elementWorldAABB` in tree-ops for that).
 *
 * Children are stored in the frame's local space, so their AABB is already in
 * that space and can be unioned directly with the frame's own AABB.
 *
 * Cached by element identity; invalidated implicitly when a new element object
 * is produced by an edit.
 */
export function subtreeBounds(el: DesignElement): Rect {
  const cached = subtreeBoundsCache.get(el);
  if (cached) return cached;

  let box = elementAABB(el);
  if (isContainer(el)) {
    for (const child of (el as ContainerElement).children || []) {
      // Child's AABB is in local space (relative to el); union directly.
      const childBox = subtreeBounds(child);
      const minX = Math.min(box.x, el.x + childBox.x);
      const minY = Math.min(box.y, el.y + childBox.y);
      const maxX = Math.max(box.x + box.width, el.x + childBox.x + childBox.width);
      const maxY = Math.max(box.y + box.height, el.y + childBox.y + childBox.height);
      box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
  }

  subtreeBoundsCache.set(el, box);
  return box;
}

/**
 * Every element's subtree bounds in WORLD coordinates, one pass per tree.
 *
 * `subtreeBounds` answers in an element's PARENT space, which is why culling was
 * top-level-only: comparing a nested element's local box to the world viewport
 * mis-culls it, and the one function that could translate (`elementWorldAABB`)
 * takes the origin as an argument, so a caller testing thousands of elements had
 * no way to get one without walking the tree per element.
 *
 * This closes that gap by paying for the translation once per tree, keyed on the
 * elements array identity — the same structural-sharing invariant
 * `flattenElements` and `parentOriginMap` already rely on, so a commit that does
 * not touch a subtree hands back the same array and this map is reused.
 *
 * Resolved instance clones are absent by construction (they are not in the
 * document tree). A missing id therefore means "no opinion", and culling must
 * treat it as visible rather than as an empty box.
 */
const worldBoundsCache = new WeakMap<DesignElement[], Map<string, Rect>>();

export function worldSubtreeBounds(elements: DesignElement[]): Map<string, Rect> {
  const cached = worldBoundsCache.get(elements);
  if (cached) return cached;

  const map = new Map<string, Rect>();
  // A matrix down the tree rather than a running offset, because culling asks
  // "is this node anywhere near the viewport" and a turned frame moves its whole
  // subtree: measured the old way, a child of one sat at a box the canvas never
  // painted and was dropped from the visible set while still on screen.
  const walk = (list: readonly DesignElement[], parentM: Matrix2D) => {
    for (const el of list) {
      const pivot = elementPivot(el);
      const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
      // `subtreeBounds` answers in PARENT space, so the chain carries it the rest
      // of the way — and the node's own turn is already in `worldM`.
      map.set(el.id, transformBoundsToAABB(subtreeBounds(el), worldM)!);
      if (isContainer(el)) walk(el.children || [], multiply(worldM, translation(el.x, el.y)));
    }
  };
  walk(elements, identityMatrix());
  worldBoundsCache.set(elements, map);
  return map;
}

/**
 * The union of an element's own PAINTED box and every descendant's, in the
 * element's parent space — the box a hit test can safely prune against.
 *
 * `subtreeBounds` answers the same shape but from stored sizes, so a turned
 * descendant that overhangs its stored box is outside it. Culling absorbs that
 * with a 250 px viewport buffer; hit-testing has no buffer, and pruning a
 * turned child away is a click that lands on the canvas instead of the layer.
 *
 * A union taken in local space and then carried through the parent's matrix is
 * still a superset of every descendant's painted region, which is the only
 * property pruning needs. Cached by element identity, like `subtreeBounds`.
 */
const paintedSubtreeCache = new WeakMap<DesignElement, Rect>();

export function paintedSubtreeBounds(el: DesignElement): Rect {
  const cached = paintedSubtreeCache.get(el);
  if (cached) return cached;

  let box = elementRotatedAABB(el);
  if (isContainer(el)) {
    for (const child of (el as ContainerElement).children || []) {
      const childBox = paintedSubtreeBounds(child);
      const minX = Math.min(box.x, el.x + childBox.x);
      const minY = Math.min(box.y, el.y + childBox.y);
      const maxX = Math.max(box.x + box.width, el.x + childBox.x + childBox.width);
      const maxY = Math.max(box.y + box.height, el.y + childBox.y + childBox.height);
      box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
  }

  paintedSubtreeCache.set(el, box);
  return box;
}

/**
 * The world rect every visible layer occupies — the box a "zoom to fit" has to
 * bring into view.
 *
 * Hidden layers are left out for the same reason the layout engine leaves them
 * out: they paint nothing, so including them would frame empty space. Children
 * are stored in their parent's local space, so the walk carries the origin down;
 * and the rotated own box is unioned in with the subtree box because a rotated
 * element paints outside the box it stores.
 */
export function contentBounds(elements: readonly DesignElement[]): Rect | null {
  // A full matrix down the tree, not a running sum of offsets: a turned frame
  // carries everything under it, so "where does this layer paint" is not the
  // stored box plus the ancestors' `x`/`y`. The child's own turn composes inside
  // the parent's, exactly as the renderer nests them.
  const walk = (list: readonly DesignElement[], parentM: Matrix2D, box: Rect | null): Rect | null => {
    for (const el of list) {
      if (el.visible === false) continue;
      const pivot = elementPivot(el);
      const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
      // `elementAABB`, not `elementRotatedAABB`: the turn is in the matrix now, so
      // handing it a box that already carries the same rotation would apply it
      // twice and grow the fit box to a size nothing paints.
      //
      // A LINE is the exception: bounding its `|dx|`x`|dy|` box through the matrix
      // bounds the turned BOX, which is up to a full segment's length of empty
      // space the line does not paint — a diagonal turned onto its own direction
      // reported 141.42 wide while covering none. The two endpoints go through
      // instead, which is the segment itself.
      const own = isLineElement(el)
        ? segmentBounds(worldM, el)
        : transformBoundsToAABB(elementAABB(el), worldM)!;
      box = unionRect(box, own);
      if (isContainer(el)) {
        // Children are emitted inside `translate(x, y)`, which the box above has
        // already accounted for.
        box = walk(el.children || [], multiply(worldM, translation(el.x, el.y)), box);
      }
    }
    return box;
  };
  return walk(elements, identityMatrix(), null);
}

/**
 * A turned line's two endpoints carried through `m` and bounded. `m` already
 * carries the line's own turn about its origin, so this is the segment the canvas
 * paints — where a bounds-through-matrix would be the box around it.
 */
function segmentBounds(m: Matrix2D, el: LineElementLike): Rect {
  const p = transformPoint(m, { x: el.x, y: el.y });
  const q = transformPoint(m, { x: el.x + el.dx, y: el.y + el.dy });
  return {
    x: Math.min(p.x, q.x),
    y: Math.min(p.y, q.y),
    width: Math.abs(q.x - p.x),
    height: Math.abs(q.y - p.y)
  };
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  };
}

export function shiftChildren(children: DesignElement[], ddx: number, ddy: number): DesignElement[] {
  if (ddx === 0 && ddy === 0) return children;
  return children.map((c) => {
    // dx/dy on line/arrow are local deltas — they do NOT need to change when the
    // parent moves; only the start endpoint (x/y) shifts.
    const next: DesignElement = { ...c, x: c.x + ddx, y: c.y + ddy };
    if ((next.type === "frame" || next.type === "component") && (next as ContainerElement).children?.length) {
      return { ...next, children: shiftChildren((next as ContainerElement).children, ddx, ddy) } as DesignElement;
    }
    return next;
  });
}

/**
 * The document's precision. This function is where an auto-layout pass hands its
 * arithmetic to the tree, so a whole-pixel rounding here is a whole-pixel rounding in
 * every frame the engine lays out: the Scale tool reads those boxes back as the ones it
 * multiplies, so a design scaled to a tenth (a 27.6px frame) came back 28px wide and
 * 280px on the way up, wider than the parent holding it. Matched to every other writer
 * in `core/` so a value is the same whichever path last touched it.
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Place an element at a computed layout position. Non-line children take the
 * box verbatim; line/arrow children move their start endpoint (x/y) while
 * preserving the direction delta (dx/dy — the drawn length never changes).
 *
 * Returns the SAME reference when the computed box is the one the child
 * already has. Every memo downstream keys on element identity — `mapElements`,
 * `MemoizedSvgNode`, `deepEqual`'s undo check — and this is the single point
 * where a layout pass writes a child box, so the check lives here rather than
 * at each of its callers. The comparison is on the ROUNDED values, because
 * those are what lands in the document: a float that rounds back to the stored
 * number is not a move.
 */
export function placeChildAt(
  child: DesignElement,
  x: number,
  y: number,
  width: number,
  height: number
): DesignElement {
  const rx = round2(x);
  const ry = round2(y);
  if (isLineElement(child)) {
    const w = Math.max(0, round2(width));
    const h = Math.max(0, round2(height));
    // Preserve the direction of the segment; only scale the magnitude.
    const sx = child.dx >= 0 ? 1 : -1;
    const sy = child.dy >= 0 ? 1 : -1;
    if (rx === child.x && ry === child.y && w === child.width && h === child.height) {
      return child;
    }
    return { ...child, x: rx, y: ry, dx: sx * w, dy: sy * h, width: w, height: h };
  }
  const rw = round2(width);
  const rh = round2(height);
  if (rx === child.x && ry === child.y && rw === child.width && rh === child.height) {
    return child;
  }
  return { ...child, x: rx, y: ry, width: rw, height: rh };
}

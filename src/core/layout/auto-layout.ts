import { AutoLayoutFields, DesignElement, ContainerElement } from "../dsl/types";
import { layoutOf } from "../dsl/layout-flat";
import { isContainer } from "../geometry/tree-ops";
import { ChildSizeResolver, hugsAxis, resolvePadding } from "./box";
import { fitComponentSet } from "./component-set";
import { resolveChildSize } from "./context";
import { syncTextSizing } from "./text-sizing";
import { applyFlexLayout } from "./flex-layout";
import { applyGridLayout, gridCellWidth, gridColumnCount } from "./grid-layout";

/**
 * Both tree passes return the INPUT array when nothing below them moved, which
 * is what makes an unchanged relayout a no-op all the way up. The `changed`
 * flag is load-bearing rather than an optimisation: `Array.prototype.map` always
 * allocates, so without it `nextChildren !== item.children` is true on every
 * call and no identity check anywhere above this can ever fire.
 */
function measureTreeBottomUp(
  elements: DesignElement[],
  resolveChild?: ChildSizeResolver
): DesignElement[] {
  let changed = false;
  const next = elements.map((item) => {
    if (isContainer(item) && item.children) {
      const nextChildren = measureTreeBottomUp(item.children, resolveChild);
      let updated: ContainerElement = nextChildren === item.children ? item : { ...item, children: nextChildren };
      if (layoutOf(updated as AutoLayoutFields)) {
        updated = applyAutoLayout(updated, resolveChild);
      }
      // A set has no layout to run, and this is the only pass that sees its
      // children already measured — which is what makes the box it computes
      // correct rather than one relayout behind.
      if (updated.type === "componentSet") {
        updated = fitComponentSet(updated);
      }
      if (updated !== item) changed = true;
      return updated;
    }
    return item;
  });
  return changed ? next : elements;
}

function positionTreeTopDown(
  elements: DesignElement[],
  resolveChild?: ChildSizeResolver
): DesignElement[] {
  let changed = false;
  const next = elements.map((item) => {
    if (isContainer(item) && item.children) {
      const current = layoutOf(item as AutoLayoutFields) ? applyAutoLayout(item, resolveChild) : item;
      const nextChildren = positionTreeTopDown(current.children, resolveChild);
      const updated = current === item && nextChildren === current.children
        ? item
        : { ...current, children: nextChildren };
      if (updated !== item) changed = true;
      return updated;
    }
    return item;
  });
  return changed ? next : elements;
}

/**
 * 2-pass auto-layout pipeline, and both passes are load-bearing.
 *
 * It is ONE fixed-point iteration truncated at 2, not two passes with separate
 * jobs. A container's size is written by its PARENT's `applyAutoLayout`, which
 * runs at a higher level of the recursion — so when pass 1 lays out a container
 * C, C still carries the width the previous relayout left on it. By the time
 * pass 1 returns to the root and the root rewrites C's width, C's own children
 * have already been positioned against the stale number. Pass 2 walks top-down
 * once more, and only now does C see its final width.
 *
 * Do not delete pass 2 on the grounds that a settled document converges — it
 * does (`tests/layout-invariants.test.ts`, "convergence per trigger": fill,
 * hug-in-hug, and a six-deep hug chain all satisfy `relayout³ == relayout¹`).
 * Convergence is not the question; freshness is. On a document where a parent's
 * pass CHANGES a child's width, one pass lays the grandchildren out against the
 * old width and the second is the only thing that corrects them — measured by
 * deleting it: `layout.test.ts` "re-runs the nested frame's own layout when a
 * `fill` frame grows" fails. Two passes is the truncation; the idempotence that
 * makes two enough is asserted, not structural.
 */
export function relayoutDocumentTree(
  elements: DesignElement[],
  resolveChild?: ChildSizeResolver
): DesignElement[] {
  // ONE resolver for both passes. They have to agree: pass 1 measures the
  // children, pass 2 positions what pass 1 measured, and a child measured by
  // the master's real size but positioned by its authored size is the overlap
  // `LESSONS §71` records.
  const childSize = resolveChildSize(resolveChild);
  const measured = measureTreeBottomUp(elements, childSize);
  const positioned = positionTreeTopDown(measured, childSize);
  const done = syncTextSizing(positioned);
  laidOut.add(done);
  return done;
}

/**
 * The trees this module has already laid out.
 *
 * Layout is idempotent but not free: the two passes measure and clone the whole
 * tree, and a page switch asked for it on every visit even though the page it
 * was opening had not changed since the last one — 2.7 ms on a 1,841-element
 * page, which is a visible hitch on a tab the user flips between.
 *
 * Keyed on the array, so an edit — which always produces a new array through
 * this function — cannot inherit the mark. The cross-page input, a master's box,
 * is kept in step by `propagateMasterSize` on every commit, which rewrites the
 * instances it changes and therefore their pages' arrays too.
 */
const laidOut = new WeakSet<DesignElement[]>();

/** Whether this exact tree has been through `relayoutDocumentTree`. */
export function isLaidOut(elements: DesignElement[]): boolean {
  return laidOut.has(elements);
}

/**
 * A container with nothing in the flow has nothing to hug, so a hugging axis
 * collapses onto its own padding. Without this the frame keeps whatever size it
 * had when its last child was removed — the one case where "Hug" visibly stops
 * working, and what left a hole behind after deleting the only child of a stack.
 * Same answer when the flow is empty because every child is hidden or out of it.
 *
 * Returns the frame itself when the collapse is already in place. `children` is
 * part of that test because this normalises a missing array to `[]`, and
 * skipping the rewrite would leave `children: undefined` on a frame the pass
 * has already decided the shape of.
 */
function hugEmptyContainer<T extends ContainerElement>(frameEl: T): T {
  const [pt, pr, pb, pl] = resolvePadding(layoutOf(frameEl as AutoLayoutFields)!.padding);
  const width = hugsAxis(frameEl, "width") ? pl + pr : frameEl.width;
  const height = hugsAxis(frameEl, "height") ? pt + pb : frameEl.height;
  const children = frameEl.children ?? [];
  if (width === frameEl.width && height === frameEl.height && children === frameEl.children) {
    return frameEl;
  }
  return { ...frameEl, width, height, children };
}

/**
 * The children an auto-layout pass is allowed to place. Two kinds are held back,
 * for the same reason: the pass has no business moving them.
 *
 * `position: "absolute"` opts out, the same check-box as Figma's "Ignore auto
 * layout" (CSS `position: absolute`), so it keeps whatever box it was given. A child with
 * `visible: false` is not on screen, and a layer that is not there cannot hold a
 * slot: the siblings close the gap and a hugging parent measures it out — Figma
 * hides a flow child the same way.
 *
 * Neither contributes to a hugging parent, and neither is touched, so its stored
 * box survives and the next pass places it the moment it comes back.
 *
 * Exported because the grid section of the inspector has to count the same
 * children the pass places: a row readout computed from every child announces a
 * row the canvas does not have.
 */
export function inFlowChildren(children: readonly DesignElement[]): DesignElement[] {
  return children.filter((c) => c.position !== "absolute" && c.visible !== false);
}

export function applyAutoLayout<T extends ContainerElement>(
  frameEl: T,
  /**
   * Real size of a child whose stored box is not the answer — see
   * `ChildSizeResolver`. Omit it and the store's published resolver is used; if
   * there is none either, an instance is measured by its authored width, which
   * is the pre-instance-hug behaviour.
   */
  resolveChild?: ChildSizeResolver
): T {
  const children = frameEl.children || [];
  if (!layoutOf(frameEl as AutoLayoutFields)) return frameEl;
  if (children.length === 0) return hugEmptyContainer(frameEl);

  // Resolved once, at the boundary, and handed to both layout algorithms: a
  // frame whose children were measured by two different rules would place them
  // against numbers that disagree about the same child.
  const childSize = resolveChildSize(resolveChild);

  const flow = inFlowChildren(children);
  // Nothing left to arrange — every child opted out or is hidden: hug onto the
  // own padding and leave the children exactly where they are.
  if (flow.length === 0) return hugEmptyContainer(frameEl);

  const laidOut = layoutOf(frameEl as AutoLayoutFields)!.mode === "grid"
    ? applyGridLayout(frameEl as any, flow, childSize)
    : applyFlexLayout(frameEl as any, flow, childSize);

  // Re-interleave rather than concatenate. `children` order is the paint order
  // and is also what the user arranged, so the placed children have to go back
  // into their authored slots instead of stacking up at the end.
  const placed = new Map((laidOut.children || []).map((c) => [c.id, c]));
  const next = children.map((c) => placed.get(c.id) ?? c);
  // Identity is a two-part claim: every child kept its box AND the frame kept
  // its own. Checking only the children would miss a hug axis that tightened
  // while every child happened to stay put — the classic case being a child
  // removed from a hugging frame.
  if (
    next.every((c, i) => c === children[i]) &&
    laidOut.width === frameEl.width &&
    laidOut.height === frameEl.height
  ) {
    return frameEl;
  }
  return { ...laidOut, children: next } as T;
}

/**
 * Which row (or column) each child currently sits in, as a 0-based index in
 * position order. Two children share an index only when their spans actually
 * overlap, so it works for the `start` / `center` / `end` cell alignments alike
 * — all three keep same-row children overlapping vertically.
 */
function clusterByOverlap(children: DesignElement[], axis: "x" | "y"): number[] {
  const start = axis === "x" ? (c: DesignElement) => c.x : (c: DesignElement) => c.y;
  const size = axis === "x" ? (c: DesignElement) => c.width : (c: DesignElement) => c.height;
  const index = new Array<number>(children.length).fill(0);
  if (children.length === 0) return index;

  const order = children.map((_, i) => i).sort((a, b) => start(children[a]) - start(children[b]));
  let cluster = 0;
  let clusterEnd = start(children[order[0]]) + size(children[order[0]]);
  index[order[0]] = cluster;
  for (let k = 1; k < order.length; k++) {
    const i = order[k];
    const s = start(children[i]);
    if (s >= clusterEnd - 0.5) {
      cluster++;
      clusterEnd = s + size(children[i]);
    } else {
      clusterEnd = Math.max(clusterEnd, s + size(children[i]));
    }
    index[i] = cluster;
  }
  return index;
}

/**
 * Sort children into their canonical layout order so a drop inside an
 * auto-layout frame reorders the stack (flex: geometric order along the main
 * axis; grid: cell index from the child's current position).
 *
 * A hidden child is not sorted at all. It is out of the flow (the layout pass
 * never placed it), so its box is whatever it happened to have when it was
 * hidden — sorting by it would move the layer to a position its geometry does
 * not describe, and the array order here *is* the layer order the user
 * arranged. It keeps its slot and the visible children sort around it.
 */
export function sortChildrenByLayoutOrder(frame: ContainerElement): DesignElement[] {
  const children = frame.children || [];
  if (!layoutOf(frame as AutoLayoutFields)) return children;
  const visible = children.filter((c) => c.visible !== false);
  if (visible.length === children.length) return sortFlowChildren(frame, children);
  const sorted = sortFlowChildren(frame, visible);
  let next = 0;
  return children.map((c) => (c.visible === false ? c : sorted[next++]));
}

function sortFlowChildren(frame: ContainerElement, children: DesignElement[]): DesignElement[] {
  const layout = layoutOf(frame as AutoLayoutFields)!;
  if (layout.mode === "grid" && layout.masonry === true) {
    const [, pr, , pl] = resolvePadding(layout.padding);
    const contentW = Math.max(0, frame.width - pl - pr);
    const colGap = layout.columnGap ?? layout.gap ?? 0;
    const columns = gridColumnCount(layout, contentW);
    const cellW = gridCellWidth(layout, contentW);
    const pitchX = cellW + colGap;
    const indexed = children.map((child) => {
      const col = Math.max(0, Math.min(columns - 1, Math.round((child.x + child.width / 2 - pl - cellW / 2) / pitchX)));
      return { child, key: col * 1000000 + (child.y + child.height / 2) };
    });
    return indexed.sort((a, b) => a.key - b.key).map((e) => e.child);
  }
  if (layout.mode === "grid") {
    const placement = layout.placement ?? "row";
    // Rows and columns are read off the boxes actually on screen. Dividing the
    // position by an average pitch silently mis-sorts as soon as heights differ:
    // a 20px child next to a 200px one landed a row away from where it was
    // dropped, because the average row height is neither of theirs.
    const rowOf = clusterByOverlap(children, "y");
    const colOf = clusterByOverlap(children, "x");
    // Ties inside one cell are broken by the reading-axis coordinate, so a box
    // dropped just left of another lands before it rather than after.
    return children
      .map((child, i) => ({ child, row: rowOf[i], col: colOf[i] }))
      .sort((a, b) =>
        placement === "column"
          ? a.col - b.col || a.row - b.row || a.child.y - b.child.y
          : a.row - b.row || a.col - b.col || a.child.x - b.child.x
      )
      .map((e) => e.child);
  }
  const isRow = layout.direction === "row";
  if (layout.wrap !== "wrap") {
    return [...children].sort((a, b) => (isRow ? a.x - b.x : a.y - b.y));
  }
  // A wrapped stack has several lines, and one axis alone interleaves them: the
  // second line starts at the same coordinate the first one did, so a plain `x`
  // sort drops a line-2 child between two line-1 children. Group into lines by
  // cross-axis overlap first, then read each line along the main axis.
  const lineOf = clusterByOverlap(children, isRow ? "y" : "x");
  return children
    .map((child, i) => ({ child, line: lineOf[i] }))
    .sort((a, b) => a.line - b.line || (isRow ? a.child.x - b.child.x : a.child.y - b.child.y))
    .map((e) => e.child);
}

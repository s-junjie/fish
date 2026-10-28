import { describe, it, expect } from "vitest";
import { computeVisibleElementIds, isElementInViewport, type ViewportBox } from "../src/core/geometry/cull";
import { subtreeBounds } from "../src/core/geometry/element-bounds";
import type { ContainerElement, DesignElement, TextElement } from "../src/core/dsl/types";

/**
 * The cull now answers from a cached topology instead of rebuilding a parent
 * map per frame. These cases grade it against the walk it replaced, written out
 * here as an oracle rather than as a list of ids: the point of the change is
 * that the answer is the same while the cost is not.
 */
function referenceCull(
  allElements: DesignElement[],
  viewportBox: ViewportBox | null | undefined,
  selectedIds: Set<string>
): Set<string> {
  const visible = new Set<string>();
  if (!viewportBox) {
    for (const el of allElements) visible.add(el.id);
    return visible;
  }
  const childIds = new Set<string>();
  for (const el of allElements) for (const c of (el as ContainerElement).children || []) childIds.add(c.id);
  const roots = allElements.filter((el) => !childIds.has(el.id));

  const rendering = new Set<string>();
  const topLevelOf = new Map<string, string>();
  const assign = (list: DesignElement[], tlId: string) => {
    for (const el of list) {
      topLevelOf.set(el.id, tlId);
      const kids = (el as ContainerElement).children;
      if (kids && kids.length) assign(kids, tlId);
    }
  };
  for (const root of roots) {
    assign([root], root.id);
    if (
      selectedIds.has(root.id) ||
      root.isMask === true ||
      Boolean((root as TextElement).onPath?.pathId) ||
      isElementInViewport(subtreeBounds(root), viewportBox)
    ) {
      rendering.add(root.id);
    }
  }
  for (const el of allElements) {
    if (selectedIds.has(el.id) || el.isMask === true || Boolean((el as TextElement).onPath?.pathId)) {
      visible.add(el.id);
      continue;
    }
    const tl = topLevelOf.get(el.id);
    if (tl !== undefined && rendering.has(tl)) visible.add(el.id);
  }
  return visible;
}

const frame = (id: string, x: number, y: number, children: DesignElement[]): DesignElement => ({
  id,
  type: "frame",
  x,
  y,
  width: 400,
  height: 300,
  children
});

const rect = (id: string, x: number, y: number, extra: Record<string, unknown> = {}): DesignElement =>
  ({ id, type: "rect", x, y, width: 80, height: 60, ...extra }) as DesignElement;

describe("computeVisibleElementIds", () => {
  const tree: DesignElement[] = [
    frame("near", 0, 0, [rect("near_a", 10, 10), rect("near_mask", 20, 20, { isMask: true })]),
    frame("far", 6000, 0, [rect("far_a", 10, 10), rect("far_b", 200, 200)])
  ];
  const flat = (els: DesignElement[]): DesignElement[] => {
    const out: DesignElement[] = [];
    const walk = (list: DesignElement[]) => {
      for (const el of list) {
        out.push(el);
        walk((el as ContainerElement).children || []);
      }
    };
    walk(els);
    return out;
  };
  const all = flat(tree);
  const vp: ViewportBox = { x: -50, y: -50, width: 500, height: 400 };

  it("matches the per-frame walk on a two-frame page", () => {
    for (const selected of [new Set<string>(), new Set(["far_a"]), new Set(["far"]), new Set(["ghost"])]) {
      expect([...computeVisibleElementIds(all, vp, selected)].sort()).toEqual(
        [...referenceCull(all, vp, selected)].sort()
      );
    }
  });

  it("keeps the whole subtree of a selected root, and every mask anywhere", () => {
    const visible = computeVisibleElementIds(all, vp, new Set(["far"]));
    expect(visible.has("far_a")).toBe(true);
    expect(visible.has("far_b")).toBe(true);
    expect(visible.has("near_mask")).toBe(true);
    expect(visible.has("near_a")).toBe(true);
  });

  it("drops an offscreen subtree nobody asked for", () => {
    const visible = computeVisibleElementIds(all, vp, new Set());
    expect(visible.has("far_a")).toBe(false);
    expect(visible.has("far_b")).toBe(false);
  });

  it("answers every id when there is no viewport", () => {
    expect(computeVisibleElementIds(all, null, new Set()).size).toBe(all.length);
  });

  it("ignores a selected id that is not on the page", () => {
    expect(computeVisibleElementIds(all, vp, new Set(["ghost"])).has("ghost")).toBe(false);
  });

  it("reuses one answer for repeated frames and stays correct after a move", () => {
    const first = computeVisibleElementIds(all, vp, new Set());
    const second = computeVisibleElementIds(all, vp, new Set());
    expect([...second].sort()).toEqual([...first].sort());
    const moved = computeVisibleElementIds(all, { x: 5950, y: -50, width: 500, height: 400 }, new Set());
    expect(moved.has("far_a")).toBe(true);
    expect(moved.has("near_a")).toBe(false);
  });
});

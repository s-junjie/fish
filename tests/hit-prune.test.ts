import { describe, it, expect } from "vitest";
import { findElementAtPoint, findFrameAtPoint } from "../src/core/geometry/tree-hit";
import { elementAABB } from "../src/core/geometry/element-bounds";
import { identityMatrix, invert, multiply, transformPoint, translation, type Matrix2D } from "../src/core/geometry/matrix";
import { elementPivot, elementTransformMatrix } from "../src/core/geometry/transforms";
import { isContainer } from "../src/core/geometry/tree-ops";
import type { ContainerElement, DesignElement } from "../src/core/dsl/types";

/**
 * Hit-testing now prunes subtrees by their painted (rotation-aware) world box
 * before carrying the point into each node's own space. These cases grade the
 * pruned walk against the exhaustive one it replaced, over a grid of points
 * that deliberately crosses every box, rotated layer and overhang.
 */
function referenceElementAtPoint(
  elements: DesignElement[],
  x: number,
  y: number,
  opts: { includeLocked?: boolean } = {}
): DesignElement | null {
  const { includeLocked = false } = opts;
  function search(list: DesignElement[], parentM: Matrix2D): DesignElement | null {
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (el.visible === false || (el.locked && !includeLocked)) continue;
      const pivot = elementPivot(el);
      const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
      if (isContainer(el) && el.children && el.children.length > 0) {
        const childMatch = search(el.children, multiply(worldM, translation(el.x, el.y)));
        if (childMatch) return childMatch;
      }
      const local = invert(worldM);
      if (!local) continue;
      const p = transformPoint(local, { x, y });
      const b = elementAABB(el);
      const eps = 0.5;
      if (p.x >= b.x - eps && p.x <= b.x + b.width + eps && p.y >= b.y - eps && p.y <= b.y + b.height + eps) {
        return el;
      }
    }
    return null;
  }
  return search(elements, identityMatrix());
}

function referenceFrameAtPoint(elements: DesignElement[], x: number, y: number): ContainerElement | null {
  function search(list: DesignElement[], parentM: Matrix2D): ContainerElement | null {
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (el.visible === false || el.locked) continue;
      if (isContainer(el)) {
        const pivot = elementPivot(el);
        const worldM = multiply(parentM, elementTransformMatrix(el, pivot.x, pivot.y));
        const childMatch = search(el.children || [], multiply(worldM, translation(el.x, el.y)));
        if (childMatch) return childMatch;
        const local = invert(worldM);
        if (!local) continue;
        const p = transformPoint(local, { x, y });
        const b = elementAABB(el);
        if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return el;
      }
    }
    return null;
  }
  return search(elements, identityMatrix());
}

const rect = (id: string, x: number, y: number, w = 80, h = 60, extra: Record<string, unknown> = {}) =>
  ({ id, type: "rect", x, y, width: w, height: h, ...extra }) as unknown as DesignElement;

const frame = (id: string, x: number, y: number, children: DesignElement[], extra: Record<string, unknown> = {}) =>
  ({ id, type: "frame", x, y, width: 400, height: 300, children, ...extra }) as unknown as DesignElement;

const tree: DesignElement[] = [
  frame("near", 0, 0, [
    rect("near_rect", 10, 10),
    rect("near_turned", 120, 40, 120, 40, { rotation: 45 }),
    frame("near_nested", 40, 200, [rect("nested_child", 10, 10), rect("nested_turned", 100, 30, 60, 20, { rotation: 30 })])
  ]),
  frame("far", 1000, 0, [rect("far_child", 10, 10), rect("far_overflow", -70, 260, 120, 60)]),
  rect("turned_root", 700, 500, 300, 30, { rotation: 35 }),
  rect("hidden", 0, 0, 500, 500, { visible: false }),
  rect("locked", 900, 700, 200, 200, { locked: true })
];

describe("hit-test pruning", () => {
  it("finds the same element as the exhaustive walk over a point grid", () => {
    const mismatches: string[] = [];
    for (let x = -80; x <= 1400; x += 23) {
      for (let y = -80; y <= 1000; y += 19) {
        const found = findElementAtPoint(tree, x, y)?.id ?? null;
        const expected = referenceElementAtPoint(tree, x, y)?.id ?? null;
        if (found !== expected) mismatches.push(`(${x},${y}) ${expected} != ${found}`);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("finds the same frame as the exhaustive walk", () => {
    const mismatches: string[] = [];
    for (let x = -80; x <= 1400; x += 31) {
      for (let y = -80; y <= 1000; y += 29) {
        const found = findFrameAtPoint(tree, x, y)?.id ?? null;
        const expected = referenceFrameAtPoint(tree, x, y)?.id ?? null;
        if (found !== expected) mismatches.push(`(${x},${y}) ${expected} != ${found}`);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("still hits a rotated child outside its stored box", () => {
    // A 45° bar paints outside its stored box; pruning by the stored union
    // would lose such a point, which is the reason the prune is rotation-aware.
    // The point is found by the exhaustive walk rather than hand-placed: it has
    // to be inside the turned envelope AND outside the unrotated box.
    const nearFrame = tree[0] as ContainerElement;
    const stored = elementAABB(nearFrame.children![1]);
    let probe: { x: number; y: number } | null = null;
    for (let x = 100; x <= 260 && !probe; x += 2) {
      for (let y = 0; y <= 120 && !probe; y += 2) {
        const inStored = x >= stored.x && x <= stored.x + stored.width && y >= stored.y && y <= stored.y + stored.height;
        if (inStored) continue;
        if (referenceElementAtPoint(tree, x, y)?.id === "near_turned") probe = { x, y };
      }
    }
    expect(probe).not.toBeNull();
    expect(findElementAtPoint(tree, probe!.x, probe!.y)?.id).toBe("near_turned");
  });

  it("respects includeLocked and excludeId after pruning", () => {
    expect(findElementAtPoint(tree, 950, 750)).toBeNull();
    expect(findElementAtPoint(tree, 950, 750, { includeLocked: true })?.id).toBe("locked");
    expect(findElementAtPoint(tree, 30, 30, { excludeId: "near_rect" })?.id).toBe("near");
  });

  it("returns null well outside every painted subtree", () => {
    expect(findElementAtPoint(tree, 5000, 5000)).toBeNull();
    expect(findFrameAtPoint(tree, 5000, 5000)).toBeNull();
  });
});

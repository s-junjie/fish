import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { relayoutDocumentTree, applyAutoLayout } from "../src/core/compile";
import { placeChildAt } from "../src/core/geometry/element-bounds";
import { ContainerElement, DesignElement, FrameElement, RectElement } from "../src/core/dsl/types";

/**
 * Structural sharing is the foundation of every memo in the app, not an
 * optimisation: `mapElements` returns the same array when nothing changed,
 * `MemoizedSvgNode` compares `el` by reference first, and `deepEqual`'s undo
 * check only stays proportional to the changed path while untouched subtrees
 * are pointer-equal. A relayout that reallocates every container therefore
 * invalidates the whole tree after every edit, even one that touched a leaf.
 *
 * These assertions are about object identity, not geometry — the numbers were
 * already correct; what was missing was the ability to say "nothing moved".
 */

const rect = (id: string, x = 0, y = 0, w = 60, h = 40): RectElement =>
  ({ id, type: "rect", x, y, width: w, height: h }) as RectElement;

const row = (id: string, children: DesignElement[]): FrameElement =>
  ({
    id,
    type: "frame",
    x: 0,
    y: 0,
    width: 400,
    height: 120,
    ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 10 }),
    children
  }) as FrameElement;

const kids = (el: DesignElement): DesignElement[] => (el as ContainerElement).children ?? [];

describe("placeChildAt", () => {
  it("returns the same reference when the box does not move", () => {
    const r = rect("a", 12, 34, 60, 40);
    expect(placeChildAt(r, 12, 34, 60, 40)).toBe(r);
  });

  it("rounds before comparing, so a sub-precision delta is not a move", () => {
    const r = rect("a", 10, 10, 60, 40);
    // 10.0001 rounds to 10 at the document's own precision.
    expect(placeChildAt(r, 10.0001, 10, 60, 40)).toBe(r);
  });

  it("returns a new object carrying the right values when the box does move", () => {
    const r = rect("a", 0, 0, 60, 40);
    const moved = placeChildAt(r, 80, 16, 60, 40);
    expect(moved).not.toBe(r);
    expect([moved.x, moved.y, moved.width, moved.height]).toEqual([80, 16, 60, 40]);
  });

  it("keeps a line's direction when it is re-placed at its own box", () => {
    const line = { id: "l", type: "line", x: 5, y: 5, width: 30, height: 20, dx: -30, dy: 20 } as any;
    expect(placeChildAt(line, 5, 5, 30, 20)).toBe(line);
  });

  it("preserves a line's dx/dy sign when it is re-placed elsewhere", () => {
    const line = { id: "l", type: "line", x: 5, y: 5, width: 30, height: 20, dx: -30, dy: 20 } as any;
    const moved = placeChildAt(line, 5, 40, 30, 20) as any;
    expect(moved).not.toBe(line);
    expect([moved.x, moved.y, moved.dx, moved.dy]).toEqual([5, 40, -30, 20]);
  });
});

describe("applyAutoLayout", () => {
  it("returns the same reference when the frame is already laid out", () => {
    const laid = applyAutoLayout(row("f", [rect("a"), rect("b")]));
    expect(applyAutoLayout(laid)).toBe(laid);
  });

  it("returns the same reference for an empty hug container that already collapsed", () => {
    const empty = {
      id: "e", type: "frame", x: 0, y: 0, width: 20, height: 24,
      sizing: { width: "fit-content", height: "fit-content" },
      ...flattenLayout({ mode: "flex", direction: "row", gap: 8, padding: 10 }),
      children: []
    } as unknown as FrameElement;
    const laid = applyAutoLayout(empty);
    expect(applyAutoLayout(laid)).toBe(laid);
  });
});

describe("relayoutDocumentTree", () => {
  it("keeps the whole tree pointer-equal when nothing needs to move", () => {
    const settled = relayoutDocumentTree([row("f", [rect("a"), rect("b")])]);
    const again = relayoutDocumentTree(settled);
    expect(again).toBe(settled);
    expect(again[0]).toBe(settled[0]);
  });

  it("reuses every container on a branch the edit did not reach", () => {
    const before = relayoutDocumentTree([
      row("root", [row("left", [rect("la")]), row("right", [rect("ra"), rect("rb")])])
    ]);
    const b = before[0] as FrameElement;
    const bRight = b.children[1] as FrameElement;

    // Widen `ra`. That moves `rb` (it is displaced) and re-lays `right` and
    // `root`; the `left` branch is a different subtree and must survive intact.
    const edited = relayoutDocumentTree([
      {
        ...b,
        children: [
          b.children[0],
          { ...bRight, children: [rect("ra", 0, 0, 90, 40), bRight.children[1]] }
        ]
      } as FrameElement
    ]);
    const e = edited[0] as FrameElement;
    const eRight = e.children[1] as FrameElement;

    // The changed leaf and its two ancestors are new objects.
    expect(e).not.toBe(b);
    expect(eRight).not.toBe(bRight);
    expect(eRight.children[0]).not.toBe(bRight.children[0]);
    // `rb` really was displaced, so it is a new object too — identity follows
    // the numbers, not the edit.
    expect(eRight.children[1]).not.toBe(bRight.children[1]);
    expect((eRight.children[1] as RectElement).x).toBe(108);

    // The untouched branch keeps every object, including its own leaf.
    expect(e.children[0]).toBe(b.children[0]);
    expect((e.children[0] as FrameElement).children[0]).toBe((b.children[0] as FrameElement).children[0]);
  });
});

import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { applyAutoLayout, applyDropSlot, computeDropSlot } from "../src/core/compile";
import { FrameElement, RectElement } from "../src/core/dsl/types";

const rect = (id: string, w: number, h: number, sizing?: any): RectElement =>
  ({ id, type: "rect", x: 0, y: 0, width: w, height: h, sizing } as RectElement);

describe("drop slot", () => {
  const stack: FrameElement = {
    id: "f",
    type: "frame",
    x: 0,
    y: 0,
    width: 300,
    height: 60,
    ...flattenLayout({ mode: "flex", direction: "row", gap: 10, padding: 8 }),
    children: [rect("a", 80, 40), rect("b", 80, 40), rect("c", 80, 40)]
  };

  it("points before or after the sibling depending on which half was hit", () => {
    const laid = applyAutoLayout(stack);
    const b = laid.children[1];
    const before = computeDropSlot(laid, new Set(["c"]), { x: b.x + 2, y: b.y + 20 });
    const after = computeDropSlot(laid, new Set(["c"]), { x: b.x + b.width - 2, y: b.y + 20 });
    // Indices are among the siblings that stay, so "c" splices in at 1 or 2.
    expect(before?.index).toBe(1);
    expect(after?.index).toBe(2);
    expect(before?.width).toBeLessThanOrEqual(2);
  });

  it("excludes the dragged child from the siblings it counts", () => {
    const laid = applyAutoLayout(stack);
    const slot = computeDropSlot(laid, new Set(["a"]), { x: laid.children[2].x + 70, y: 20 });
    expect(slot?.index).toBe(2);
  });

  it("shows the whole content box when there is nothing to displace", () => {
    const empty = applyAutoLayout({ ...stack, children: [rect("a", 80, 40)] } as FrameElement);
    const slot = computeDropSlot(empty, new Set(["a"]), { x: 150, y: 30 });
    expect(slot).not.toBeNull();
    expect(slot?.index).toBe(0);
    expect(slot?.width).toBeGreaterThan(2);
  });

  it("commits to the order the slot promised", () => {
    const laid = applyAutoLayout(stack);
    const slot = computeDropSlot(laid, new Set(["c"]), { x: laid.children[0].x + 70, y: 20 });
    const children = laid.children!;
    const moving = children.filter((c) => c.id === "c");
    const rest = children.filter((c) => c.id !== "c");
    const at = slot!.index;
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    expect(next.map((c) => c.id)).toEqual(["a", "c", "b"]);
  });
  it("never aims at a hidden sibling", () => {
    // "b" was hidden after being authored far to the right; the stack closed up
    // over it. Its leftover box is not on screen, so it must not be what the slot
    // bar is drawn against — nor the sibling the index is counted from.
    const frame: FrameElement = {
      ...stack,
      children: [rect("a", 80, 40), { ...rect("b", 80, 40), x: 600, visible: false }, rect("c", 80, 40)]
    };
    const laid = applyAutoLayout(frame);
    expect(laid.children![2].x).toBe(98);
    const slot = computeDropSlot(laid, new Set(), { x: 620, y: 20 });
    expect(slot?.index).toBe(3);
    expect(slot!.x).toBeLessThanOrEqual(300);
  });

  it("shows the content box when every sibling is hidden", () => {
    const frame: FrameElement = {
      ...stack,
      children: [rect("a", 80, 40), rect("b", 80, 40)].map((c) => ({ ...c, visible: false }))
    };
    const slot = computeDropSlot(applyAutoLayout(frame), new Set(), { x: 150, y: 30 });
    // Nothing to displace, and the drop still lands at the end of the array.
    expect(slot?.index).toBe(2);
    expect(slot?.width).toBeGreaterThan(2);
  });
});

describe("applying a drop slot", () => {
  const parent = (): FrameElement =>
    applyAutoLayout({
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 60,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 10, padding: 8 }),
      children: [rect("a", 80, 40), rect("b", 80, 40), rect("c", 80, 40), rect("d", 80, 40)]
    } as FrameElement);

  const ids = (children: { id: string }[]) => children.map((c) => c.id);

  it("splices one dragged child in at the slot", () => {
    expect(ids(applyDropSlot(parent(), new Set(["d"]), 1))).toEqual(["a", "d", "b", "c"]);
  });

  it("keeps the selection together — a multi-select drop moves as a block", () => {
    const next = applyDropSlot(parent(), new Set(["a", "b"]), 1);
    expect(ids(next)).toEqual(["c", "a", "b", "d"]);
  });

  it("clamps a slot past the end", () => {
    expect(ids(applyDropSlot(parent(), new Set(["a"]), 99))).toEqual(["b", "c", "d", "a"]);
  });

  it("leaves the children alone when nothing selected is a child", () => {
    const p = parent();
    expect(applyDropSlot(p, new Set(["nope"]), 2)).toBe(p.children);
  });
});

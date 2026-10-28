import { describe, expect, it } from "vitest";
import {
  cssPaintOrder,
  moveStackRow,
  paintLayerIndex,
  slotFromPointerY,
  stackRows,
  topPaint
} from "../src/core/dsl/paint-stack";
import { Paint } from "../src/core/dsl/types";

describe("paint stack ordering", () => {
  it("lists the top-most paint or effect first while keeping storage indices", () => {
    const rows = stackRows(["bottom", "middle", "top"]);
    expect(rows.map((r) => r.item)).toEqual(["top", "middle", "bottom"]);
    expect(rows.map((r) => r.index)).toEqual([2, 1, 0]);

    // Effects are stored bottom-first: [Glass, InnerShadow1, InnerShadow2]
    // stackRows presents them top-first in the UI: [InnerShadow2, InnerShadow1, Glass]
    const effectRows = stackRows(["Glass", "InnerShadow1", "InnerShadow2"]);
    expect(effectRows.map((r) => r.item)).toEqual(["InnerShadow2", "InnerShadow1", "Glass"]);
    expect(effectRows.map((r) => r.index)).toEqual([2, 1, 0]);
  });

  it("handles empty and undefined stacks", () => {
    expect(stackRows([])).toEqual([]);
    expect(stackRows(undefined)).toEqual([]);
    expect(stackRows(null)).toEqual([]);
  });

  it("moves the top row to the bottom", () => {
    // storage [A,B,C] -> UI [C,B,A]; drag UI 0 (C) past the last row (slot 3).
    expect(moveStackRow(["A", "B", "C"], 0, 3)).toEqual(["C", "A", "B"]);
    expect(stackRows(moveStackRow(["A", "B", "C"], 0, 3)).map((r) => r.item)).toEqual(["B", "A", "C"]);
  });

  it("moves the bottom row to the top", () => {
    expect(moveStackRow(["A", "B", "C"], 2, 0)).toEqual(["B", "C", "A"]);
    expect(stackRows(moveStackRow(["A", "B", "C"], 2, 0)).map((r) => r.item)).toEqual(["A", "C", "B"]);
  });

  it("moves a middle row up one slot", () => {
    // UI [C,B,A]; drag B (ui 1) above C (slot 0) -> UI [B,C,A].
    expect(stackRows(moveStackRow(["A", "B", "C"], 1, 0)).map((r) => r.item)).toEqual(["B", "C", "A"]);
  });

  it("moves a middle row down one slot", () => {
    // UI [C,B,A]; drag B (ui 1) below A (slot 3) -> UI [C,A,B].
    expect(stackRows(moveStackRow(["A", "B", "C"], 1, 3)).map((r) => r.item)).toEqual(["C", "A", "B"]);
  });

  it("treats a drop onto its own slot as a no-op", () => {
    expect(moveStackRow(["A", "B", "C"], 1, 1)).toEqual(["A", "B", "C"]);
    expect(moveStackRow(["A", "B", "C"], 1, 2)).toEqual(["A", "B", "C"]);
    expect(moveStackRow(["A", "B", "C"], 0, 0)).toEqual(["A", "B", "C"]);
    expect(moveStackRow(["A", "B", "C"], 2, 3)).toEqual(["A", "B", "C"]);
  });

  it("never mutates the input array", () => {
    const list = ["A", "B", "C"];
    moveStackRow(list, 0, 3);
    expect(list).toEqual(["A", "B", "C"]);
  });

  it("clamps out-of-range UI positions", () => {
    expect(moveStackRow(["A", "B"], 0, 99)).toEqual(["B", "A"]);
    expect(moveStackRow(["A", "B"], 5, 0)).toEqual(["A", "B"]);
    expect(moveStackRow(["A", "B"], 0, -3)).toEqual(["A", "B"]);
  });

  // Guards the storage-index reversal: a single off-by-one flips the whole stack.
  it("keeps every other row's relative order and lands the moved row on its slot", () => {
    const list = ["A", "B", "C", "D", "E"];
    for (let from = 0; from < list.length; from++) {
      for (let slot = 0; slot <= list.length; slot++) {
        const uiBefore = list.slice().reverse();
        const uiAfter = moveStackRow(list, from, slot).slice().reverse();
        const moved = uiBefore[from];

        expect(uiAfter).toHaveLength(list.length);
        expect(uiAfter.slice().sort()).toEqual(uiBefore.slice().sort());
        expect(uiAfter.filter((x) => x !== moved)).toEqual(uiBefore.filter((_, i) => i !== from));

        const others = uiBefore.length - 1;
        const expectedPos = Math.max(0, Math.min(others, slot > from ? slot - 1 : slot));
        expect(uiAfter.indexOf(moved)).toBe(expectedPos);
      }
    }
  });

  it("derives insert slots from row midpoints", () => {
    const centers = [10, 30, 50];
    expect(slotFromPointerY(centers, 0)).toBe(0);
    expect(slotFromPointerY(centers, 9)).toBe(0);
    expect(slotFromPointerY(centers, 10)).toBe(1);
    expect(slotFromPointerY(centers, 29)).toBe(1);
    expect(slotFromPointerY(centers, 31)).toBe(2);
    expect(slotFromPointerY(centers, 49)).toBe(2);
    expect(slotFromPointerY(centers, 999)).toBe(3);
  });

  it("returns slot 0 for an empty list", () => {
    expect(slotFromPointerY([], 42)).toBe(0);
  });
});

const solid = (color: string, enabled?: boolean): Paint =>
  ({ type: "solid", color, ...(enabled === false ? { enabled: false } : {}) } as Paint);

describe("paint stack layer selection", () => {
  it("reads the top-most layer, not index 0", () => {
    expect(topPaint([solid("#000000"), solid("#FFFFFF")])).toMatchObject({ color: "#FFFFFF" });
    expect(topPaint([solid("#000000")])).toMatchObject({ color: "#000000" });
    expect(topPaint([])).toBeUndefined();
    expect(topPaint(undefined)).toBeUndefined();
  });

  it("skips hidden layers when reading the top", () => {
    expect(topPaint([solid("#000000"), solid("#FFFFFF", false)])).toMatchObject({ color: "#000000" });
  });

  it("reverses storage order for CSS background", () => {
    expect(cssPaintOrder(["bottom", "top"])).toEqual(["top", "bottom"]);
    const stack = ["bottom", "top"];
    cssPaintOrder(stack);
    expect(stack).toEqual(["bottom", "top"]);
  });

  it("keys defs off the source stack, not a filtered view", () => {
    const source = [solid("#000000", false), solid("#FFFFFF")];
    const enabled = source.filter((p) => p.enabled !== false);
    expect(paintLayerIndex(source, enabled[0], 0)).toBe(1);
    expect(paintLayerIndex(source, undefined as never, 0)).toBe(0);
  });
});

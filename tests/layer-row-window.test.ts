import { describe, it, expect } from "vitest";
import {
  collapsedRunHeight,
  LAYER_LIST_PADDING,
  LAYER_ROW_GAP_NESTED,
  LAYER_ROW_GAP_ROOT,
  LAYER_ROW_HEIGHT,
  planRows,
  rowIsVisible,
  selectedSubtreeIds,
  visibleRowWindow
} from "../src/ui/layers/row-window";
import { childrenOf } from "../src/core/geometry/tree-ops";
import type { DesignElement } from "../src/core/dsl/types";

const frame = (id: string, children: DesignElement[] = []): DesignElement =>
  ({ id, type: "frame", x: 0, y: 0, width: 10, height: 10, children }) as DesignElement;

const opts = (collapsedIds: string[] = []) => ({
  collapsedIds: new Set(collapsedIds),
  rowsOf: (el: DesignElement) => childrenOf(el),
  rowOrderOf: () => "z" as const
});

describe("layer row window", () => {
  it("gives a lone top-level row one row of height plus the list's own padding", () => {
    const plan = planRows([frame("a")], opts());
    expect(plan.contentHeight).toBe(LAYER_LIST_PADDING * 2 + LAYER_ROW_HEIGHT);
    expect(plan.roots).toHaveLength(1);
    expect(plan.roots[0].top).toBe(LAYER_LIST_PADDING);
  });

  it("separates top-level rows by the root gap", () => {
    const plan = planRows([frame("a"), frame("b")], opts());
    // `z` order lists the LAST child first, so "b" is the top row.
    expect(plan.roots.map((r) => r.el.id)).toEqual(["b", "a"]);
    expect(plan.roots[1].top).toBe(LAYER_LIST_PADDING + LAYER_ROW_HEIGHT + LAYER_ROW_GAP_ROOT);
  });

  it("gives an expanded subtree its children, the margin above them and the nested gaps", () => {
    const plan = planRows([frame("a", [frame("b"), frame("c")])], opts());
    const a = plan.roots[0];
    expect(a.children).toHaveLength(2);
    const expectedChildBlock =
      2 * LAYER_ROW_HEIGHT + LAYER_ROW_GAP_NESTED;
    expect(a.blockHeight).toBe(LAYER_ROW_HEIGHT + expectedChildBlock + LAYER_ROW_GAP_NESTED);
    expect(a.children[1].top).toBe(a.top + LAYER_ROW_HEIGHT + LAYER_ROW_GAP_NESTED + LAYER_ROW_HEIGHT + LAYER_ROW_GAP_NESTED);
    expect(plan.contentHeight).toBe(LAYER_LIST_PADDING * 2 + a.blockHeight);
  });

  it("drops a collapsed subtree's height without dropping the row itself", () => {
    const open = planRows([frame("a", [frame("b")])], opts());
    const shut = planRows([frame("a", [frame("b")])], opts(["a"]));
    expect(shut.roots[0].children).toHaveLength(0);
    expect(shut.roots[0].blockHeight).toBe(LAYER_ROW_HEIGHT);
    expect(open.roots[0].blockHeight).toBeGreaterThan(shut.roots[0].blockHeight);
    expect(shut.contentHeight).toBe(LAYER_LIST_PADDING * 2 + LAYER_ROW_HEIGHT);
  });

  it("marks rows under a selected row, and only those", () => {
    const tree = [frame("a", [frame("b")]), frame("c")];
    const wash = selectedSubtreeIds(tree, new Set(["a"]));
    expect(wash.has("a")).toBe(false);
    expect(wash.has("b")).toBe(true);
    expect(wash.has("c")).toBe(false);
  });

  it("nests the subtree mark: a row under a selected row's descendant is still under it", () => {
    const wash = selectedSubtreeIds([frame("a", [frame("b", [frame("c")])])], new Set(["b"]));
    expect(wash.has("c")).toBe(true);
  });

  it("marks all descendants inside subtree so only the selection root receives scope wash", () => {
    const wash = selectedSubtreeIds([frame("root", [frame("child", [frame("grandchild")])])], new Set(["root"]));
    expect(wash.has("root")).toBe(false);
    expect(wash.has("child")).toBe(true);
    expect(wash.has("grandchild")).toBe(true);
  });

  it("re-plans nothing when only the selection changes", () => {
    // The plan is geometry; where the wash sits is derived from the selection.
    const tree = [frame("a", [frame("b")])];
    const first = planRows(tree, opts());
    const second = planRows(tree, opts());
    expect(second.roots[0].top).toBe(first.roots[0].top);
    expect(selectedSubtreeIds(tree, new Set(["a"])).has("b")).toBe(true);
  });

  it("is indexable by id, which is how reveal-scroll finds a row that is not rendered", () => {
    const plan = planRows([frame("a"), frame("b")], opts());
    expect(plan.byId.get("b")!.top).toBeLessThan(plan.byId.get("a")!.top);
  });

  it("owes the gaps of the run a spacer replaces, or the list shortens as you scroll", () => {
    const plan = planRows([frame("a"), frame("b"), frame("c")], opts());
    const rows = plan.roots;
    expect(collapsedRunHeight(rows, 0, 3, LAYER_ROW_GAP_ROOT)).toBe(3 * LAYER_ROW_HEIGHT + 2 * LAYER_ROW_GAP_ROOT);
    expect(collapsedRunHeight(rows, 0, 1, LAYER_ROW_GAP_ROOT)).toBe(LAYER_ROW_HEIGHT);
    expect(collapsedRunHeight(rows, 0, 0, LAYER_ROW_GAP_ROOT)).toBe(-LAYER_ROW_GAP_ROOT);
  });

  it("treats a row as visible when any part of its block is in the band", () => {
    const plan = planRows([frame("a"), frame("b")], opts());
    const b = plan.byId.get("b")!;
    const win = { start: b.top + LAYER_ROW_HEIGHT - 1, end: b.top + LAYER_ROW_HEIGHT };
    expect(rowIsVisible(b, win)).toBe(true);
    expect(rowIsVisible(plan.byId.get("a")!, win)).toBe(false);
  });

  it("overscans so a flick does not reveal bare space", () => {
    const win = visibleRowWindow(1000, 400);
    expect(win.start).toBeLessThan(1000);
    expect(win.end).toBeGreaterThan(1400);
    expect(visibleRowWindow(0, 0, 0)).toEqual({ start: 0, end: 0 });
  });

  it("reports a taller list the deeper the tree is — the scrollbar has to mean something", () => {
    const shallow = planRows([frame("a", [frame("b")])], opts());
    const deep = planRows([frame("a", [frame("b", [frame("c")])])], opts());
    expect(deep.contentHeight).toBeGreaterThan(shallow.contentHeight);
  });

  it("tracks depths accurately on deeply nested subtrees", () => {
    let deepTree = frame("leaf");
    for (let i = 10; i >= 1; i--) {
      deepTree = frame(`level_${i}`, [deepTree]);
    }
    const plan = planRows([deepTree], opts());
    expect(plan.byId.get("leaf")!.depth).toBe(10);
  });
});

import { describe, it, expect } from "vitest";
import { DesignElement, FrameElement } from "../src/core/dsl/types";
import {
  editableIds,
  isLocked,
  setElementLocked,
  setElementsLocked,
  withLockDeep
} from "../src/core/geometry/lock";
import { findElementById, moveElementsInTree } from "../src/core/geometry/tree-ops";

function frame(id: string, children: DesignElement[] = []): FrameElement {
  return { id, type: "frame", x: 0, y: 0, width: 100, height: 100, children };
}

function rect(id: string, locked = false): DesignElement {
  return locked
    ? { id, type: "rect", x: 0, y: 0, width: 10, height: 10, locked: true }
    : { id, type: "rect", x: 0, y: 0, width: 10, height: 10 };
}

const tree = (): DesignElement[] => [
  frame("outer", [frame("inner", [rect("leaf"), rect("deep")]), rect("sibling")]),
  rect("top")
];

describe("lock is materialized onto the subtree", () => {
  it("locks every descendant, at any depth", () => {
    const locked = setElementLocked(tree(), "outer", true);
    for (const id of ["outer", "inner", "leaf", "deep", "sibling"]) {
      expect(isLocked(findElementById(locked, id)), id).toBe(true);
    }
    expect(isLocked(findElementById(locked, "top"))).toBe(false);
  });

  it("removes the key rather than storing locked: false", () => {
    const locked = setElementLocked(tree(), "inner", true);
    const unlocked = setElementLocked(locked, "inner", false);
    expect(findElementById(unlocked, "leaf")).not.toHaveProperty("locked");
    expect(findElementById(unlocked, "deep")).not.toHaveProperty("locked");
  });

  it("leaves untargeted subtrees referentially untouched", () => {
    const source = tree();
    const next = setElementLocked(source, "top", true);
    expect(next[0]).toBe(source[0]);
  });

  it("unlocks one child without touching a locked sibling", () => {
    const locked = setElementLocked(tree(), "outer", true);
    const next = setElementLocked(locked, "leaf", false);
    expect(isLocked(findElementById(next, "leaf"))).toBe(false);
    expect(isLocked(findElementById(next, "deep"))).toBe(true);
    expect(isLocked(findElementById(next, "outer"))).toBe(true);
  });
});

describe("setElementsLocked covers a whole selection", () => {
  it("locks mixed selections in one pass", () => {
    const next = setElementsLocked(tree(), new Set(["top", "inner"]), true);
    expect(isLocked(findElementById(next, "top"))).toBe(true);
    expect(isLocked(findElementById(next, "leaf"))).toBe(true);
    expect(isLocked(findElementById(next, "sibling"))).toBe(false);
  });

  it("unlocks nested ids even when the parent is selected too", () => {
    const locked = setElementsLocked(tree(), new Set(["outer", "inner"]), true);
    const next = setElementsLocked(locked, new Set(["outer", "leaf"]), false);
    expect(isLocked(findElementById(next, "outer"))).toBe(false);
    expect(isLocked(findElementById(next, "leaf"))).toBe(false);
    // `inner` was locked on its own and nobody unlocked it.
    expect(isLocked(findElementById(next, "inner"))).toBe(false);
  });
});

describe("editableIds", () => {
  it("drops locked elements and keeps the rest", () => {
    const els = [rect("a"), rect("b", true), rect("c")];
    expect([...editableIds(els, new Set(["a", "b", "c"]))]).toEqual(["a", "c"]);
  });

  it("is empty when everything selected is locked — the toggle reads this", () => {
    const els = [rect("a", true), rect("b", true)];
    expect(editableIds(els, new Set(["a", "b"])).size).toBe(0);
  });

  it("finds locked descendants, not just top-level rows", () => {
    const els = setElementLocked(tree(), "inner", true);
    expect(editableIds(els, new Set(["outer", "inner", "leaf"])).size).toBe(1);
  });

  it("keeps ids that have no element behind them", () => {
    // A node selected inside an instance is a resolved clone, absent from the
    // tree; it must survive the filter to stay draggable.
    expect([...editableIds([rect("a")], new Set(["a", "ghost"]))]).toEqual(["a", "ghost"]);
  });
});

describe("a lock survives a move", () => {
  it("keeps a deliberately locked child when its unlocked parent moves", () => {
    // Reconciling the flag against the new parent would clear this: the child
    // was locked on purpose, and nothing about the parent's move says otherwise.
    // Materialization has no way to tell it apart from an inherited one, which
    // is why no such reconcile exists.
    const locked = setElementLocked(tree(), "leaf", true);
    const moved = moveElementsInTree(locked, ["outer"], "top", "after");
    expect(isLocked(findElementById(moved, "leaf"))).toBe(true);
  });
});

describe("withLockDeep", () => {
  it("reports a locked element through isLocked", () => {
    expect(isLocked(withLockDeep(rect("a"), true))).toBe(true);
    expect(isLocked(withLockDeep(rect("a"), false))).toBe(false);
    expect(isLocked(null)).toBe(false);
  });
});

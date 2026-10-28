import { describe, it, expect } from "vitest";
import type { DesignElement } from "../src/core/dsl/types";
import { selectionTouchesSubtree } from "../src/ui/canvas/selection-scope";

/**
 * The memo comparator uses this to decide whether a selection change has
 * anything to pass down to a node's children. A node's OWN selected state is
 * its `isSelected` prop; answering `true` for the node itself would make every
 * selection re-render the whole page, which is the defect the helper exists to
 * avoid.
 */

const changed = (...ids: string[]): Set<string> => new Set(ids);

const rect = (id: string): DesignElement => ({ id, type: "rect", x: 0, y: 0, width: 10, height: 10 });

const group: DesignElement = {
  id: "group",
  type: "frame",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  children: [rect("child"), { id: "nested", type: "frame", x: 0, y: 0, width: 50, height: 50, children: [rect("grandchild")] }]
};

const instance: DesignElement = {
  id: "card",
  type: "instance",
  name: "CARD",
  componentId: "master",
  x: 0,
  y: 0,
  width: 100,
  height: 100
};

describe("selectionTouchesSubtree", () => {
  it("is false for an empty change set", () => {
    expect(selectionTouchesSubtree(group, changed())).toBe(false);
  });

  it("is false for a leaf, including when the leaf itself is selected", () => {
    // The leaf's own state arrives as `isSelected`; only its ancestors need to
    // pass something down.
    expect(selectionTouchesSubtree(rect("leaf"), changed("leaf"))).toBe(false);
    expect(selectionTouchesSubtree(rect("leaf"), changed("other"))).toBe(false);
  });

  it("is true for a container holding a selected descendant at any depth", () => {
    expect(selectionTouchesSubtree(group, changed("child"))).toBe(true);
    expect(selectionTouchesSubtree(group, changed("grandchild"))).toBe(true);
  });

  it("is false for an unrelated id or an id that merely shares a prefix", () => {
    expect(selectionTouchesSubtree(group, changed("elsewhere"))).toBe(false);
    expect(selectionTouchesSubtree(group, changed("childish"))).toBe(false);
    expect(selectionTouchesSubtree(group, changed("group"))).toBe(false);
  });

  it("is false for a container with no children", () => {
    const empty: DesignElement = { id: "empty", type: "frame", x: 0, y: 0, width: 10, height: 10, children: [] };
    expect(selectionTouchesSubtree(empty, changed("anything"))).toBe(false);
  });

  it("matches an instance's derived child ids, which only share its prefix", () => {
    // An instance stores no children: its subtree is the master resolved under
    // `<instance id>_<master child id>`, so there is nothing to walk.
    expect(selectionTouchesSubtree(instance, changed("card_label"))).toBe(true);
    expect(selectionTouchesSubtree(instance, changed("card_body_icon"))).toBe(true);
  });

  it("does not match an id that only starts with the instance id", () => {
    expect(selectionTouchesSubtree(instance, changed("cardinal_label"))).toBe(false);
    expect(selectionTouchesSubtree(instance, changed("card"))).toBe(false);
  });
});

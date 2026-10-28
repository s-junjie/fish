import { describe, it, expect } from "vitest";
import type { DesignElement, FrameElement } from "../src/core/dsl/types";
import {
  reparentSelectionIntoFrame,
  findParentById,
  findElementById,
  computeParentOrigin
} from "../src/core/geometry/tree-ops";

// World position of an element = its parent's world origin + its own local x/y.
function worldPos(elements: DesignElement[], id: string) {
  const el = findElementById(elements, id)!;
  const origin = computeParentOrigin(elements, id);
  return { x: origin.x + el.x, y: origin.y + el.y };
}

function makeFrame(id: string, x: number, y: number, children: DesignElement[]): FrameElement {
  return {
    id,
    type: "frame",
    name: id,
    x,
    y,
    width: 400,
    height: 400,
    children
  } as FrameElement;
}

function rect(id: string, x: number, y: number): DesignElement {
  return { id, type: "rect", name: id, x, y, width: 40, height: 40, fills: [] } as DesignElement;
}

describe("reparentSelectionIntoFrame (Cmd+G)", () => {
  it("nests the new frame inside the parent frame and keeps children in place", () => {
    const f = makeFrame("F", 100, 100, [rect("a", 10, 10), rect("b", 60, 60)]);
    const before = worldPos([f], "a");
    const frame: FrameElement = {
      id: "G",
      type: "frame",
      name: "Frame",
      x: 10, // bounding-box min in F's local space
      y: 10,
      width: 90,
      height: 90,
      children: [findElementById([f], "a")!, findElementById([f], "b")!]
    } as FrameElement;

    const next = reparentSelectionIntoFrame([f], [findElementById([f], "a")!, findElementById([f], "b")!], frame);

    // New frame is nested inside F, not lifted to the top level.
    expect(findParentById(next, "G")?.id).toBe("F");
    // Children are still present and positioned identically in world space.
    expect(worldPos(next, "a")).toEqual(before);
    expect(worldPos(next, "b")).toEqual(worldPos([f], "b"));
    // And they are now children of the new frame, re-based into its local space.
    expect(findParentById(next, "a")?.id).toBe("G");
    const aLocal = findElementById(next, "a")!;
    expect(aLocal.x).toBe(0); // 10 - frame.x(10)
    expect(aLocal.y).toBe(0);
  });

  it("groups top-level elements in place without shifting them", () => {
    const root: DesignElement[] = [rect("a", 10, 10), rect("b", 120, 80)];
    const frame: FrameElement = {
      id: "G",
      type: "frame",
      name: "Frame",
      x: 10,
      y: 10,
      width: 150,
      height: 110,
      children: [...root]
    } as FrameElement;

    const next = reparentSelectionIntoFrame(root, root, frame);

    expect(findParentById(next, "G")).toBeNull(); // top level
    expect(worldPos(next, "a")).toEqual({ x: 10, y: 10 });
    expect(worldPos(next, "b")).toEqual({ x: 120, y: 80 });
    const aLocal = findElementById(next, "a")!;
    expect(aLocal.x).toBe(0); // 10 - 10
    expect(aLocal.y).toBe(0);
  });

  it("preserves z-order: the new frame takes the first wrapped element's slot", () => {
    const root: DesignElement[] = [rect("x", 0, 0), rect("a", 10, 10), rect("b", 60, 60), rect("y", 200, 200)];
    const frame: FrameElement = {
      id: "G",
      type: "frame",
      name: "Frame",
      x: 10,
      y: 10,
      width: 90,
      height: 90,
      children: [findElementById(root, "a")!, findElementById(root, "b")!]
    } as FrameElement;

    const next = reparentSelectionIntoFrame(root, [findElementById(root, "a")!, findElementById(root, "b")!], frame);

    const ids = next.map((e) => e.id);
    expect(ids).toEqual(["x", "G", "y"]);
  });
});

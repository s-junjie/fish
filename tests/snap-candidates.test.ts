import { describe, it, expect } from "vitest";
import { snapCandidates } from "../src/core/geometry/snap-candidates";
import { calculateSnapping } from "../src/core/geometry/snap-guides";
import type { DesignElement } from "../src/core/dsl/types";

/**
 * The drag's snap list. It is rebuilt once per gesture rather than once per
 * frame, so these cases pin the two things that make the cached list usable:
 * it holds world-space boxes, and it excludes exactly what the gesture excludes.
 */
const rect = (id: string, x: number, y: number, w = 40, h = 30, extra: Record<string, unknown> = {}) =>
  ({ id, type: "rect", x, y, width: w, height: h, ...extra }) as unknown as DesignElement;

const frame = (id: string, x: number, y: number, children: DesignElement[]) =>
  ({ id, type: "frame", x, y, width: 200, height: 200, children }) as unknown as DesignElement;

const page: DesignElement[] = [
  frame("frame", 100, 100, [rect("child", 10, 20), rect("inner", 0, 0, 10, 10)]),
  rect("free", 500, 500),
  rect("far", 9000, 9000)
];
const none: ReadonlySet<string> = new Set();

describe("snapCandidates", () => {
  it("reports a nested element's box in world coordinates", () => {
    const [child] = snapCandidates(page, none, none, null).filter((el) => el.id === "child");
    expect(child).toMatchObject({ x: 110, y: 120, width: 40, height: 30 });
  });

  it("drops the dragged elements and their snap-exempt subtrees", () => {
    const ids = snapCandidates(page, new Set(["child"]), new Set(["free"]), null).map((el) => el.id);
    expect(ids).not.toContain("child");
    expect(ids).not.toContain("free");
    expect(ids).toEqual(expect.arrayContaining(["frame", "inner", "far"]));
  });

  it("keeps only what is inside the viewport", () => {
    const ids = snapCandidates(page, none, none, { x: 0, y: 0, width: 1000, height: 1000 }).map((el) => el.id);
    expect(ids).toEqual(expect.arrayContaining(["frame", "child", "free"]));
    expect(ids).not.toContain("far");
  });

  it("answers through the same geometry the snapping math reads", () => {
    // The list carries a flat box, not a copy of the element. `calculateSnapping`
    // reads candidates through `elementAABB`, so a line keeps `dx`/`dy` to keep
    // answering through its own geometry.
    const line: DesignElement = { id: "line", type: "line", x: 40, y: 60, dx: -80, dy: -20, width: 80, height: 20 } as DesignElement;
    const list = snapCandidates([line], none, none, null);
    const snap = calculateSnapping({ x: 0, y: 0, width: 10, height: 10 }, 2000, 2000, list);
    expect(snap.guides.length).toBeGreaterThan(0);
  });
});

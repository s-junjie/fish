import { describe, it, expect } from "vitest";
import { snapCandidates } from "../src/core/geometry/snap-candidates";
import { calculateSnapping } from "../src/core/geometry/snap-guides";
import type { DesignElement } from "../src/core/dsl/types";

/**
 * The drag's snap list. It is rebuilt once per gesture rather than once per
 * frame, so these cases pin the three things that make the cached list usable:
 * it holds world-space boxes, it excludes exactly what the gesture excludes
 * (whole subtrees, hidden layers included), and it never descends into frames
 * unrelated to what is being moved.
 */
const rect = (id: string, x: number, y: number, w = 40, h = 30, extra: Record<string, unknown> = {}) =>
  ({ id, type: "rect", x, y, width: w, height: h, ...extra }) as unknown as DesignElement;

const frame = (id: string, x: number, y: number, children: DesignElement[], extra: Record<string, unknown> = {}) =>
  ({ id, type: "frame", x, y, width: 200, height: 200, children, ...extra }) as unknown as DesignElement;

const page: DesignElement[] = [
  frame("frame", 100, 100, [rect("child", 10, 20), rect("inner", 0, 0, 10, 10)]),
  rect("free", 500, 500),
  rect("far", 9000, 9000)
];
const none: ReadonlySet<string> = new Set();

describe("snapCandidates", () => {
  it("reports a nested element's box in world coordinates", () => {
    const [child] = snapCandidates(page, new Set(["inner"]), none, null).filter((el) => el.id === "child");
    expect(child).toMatchObject({ x: 110, y: 120, width: 40, height: 30 });
  });

  it("drops the dragged elements and their snap-exempt subtrees", () => {
    const ids = snapCandidates(page, new Set(["child"]), new Set(["free"]), null).map((el) => el.id);
    expect(ids).not.toContain("child");
    expect(ids).not.toContain("free");
    expect(ids).toEqual(expect.arrayContaining(["frame", "inner", "far"]));
  });

  it("prunes the dragged container's own subtree", () => {
    const ids = snapCandidates(page, new Set(["frame"]), none, null).map((el) => el.id);
    expect(ids).not.toContain("child");
    expect(ids).not.toContain("inner");
    expect(ids).toContain("far");
  });

  it("never snaps a frame to where its children stood when the drag began", () => {
    // The reported defect: dragging "frame" (child pinned at its edge) listed
    // the child's frozen start box as a candidate and glued the frame to it.
    const list = snapCandidates(page, new Set(["frame"]), none, null);
    const snap = calculateSnapping(
      { x: 103, y: 103, width: 200, height: 200 },
      1,
      4000,
      4000,
      list.filter((el) => el.id === "far")
    );
    // "far" sits at 9000 — nothing within reach, so nothing may pull the frame.
    expect(snap.snappedX).toBe(103);
    expect(snap.guides).toHaveLength(0);
  });

  it("drops hidden layers and everything a hidden container holds", () => {
    const tree: DesignElement[] = [
      rect("ghost", 10, 10, 40, 30, { visible: false }),
      frame("veil", 300, 300, [rect("buried", 1, 1)] as DesignElement[], { visible: false }),
      rect("seen", 500, 500)
    ];
    const ids = snapCandidates(tree, new Set(["seen"]), none, null).map((el) => el.id);
    expect(ids).not.toContain("ghost");
    expect(ids).not.toContain("veil");
    expect(ids).not.toContain("buried");
  });

  it("does not descend into frames unrelated to what is being moved", () => {
    const tree: DesignElement[] = [
      frame("host", 0, 0, [rect("sibA", 5, 5), frame("stranger", 50, 50, [rect("deep", 1, 1)])]),
      rect("top", 500, 500)
    ];
    const ids = snapCandidates(tree, new Set(["sibA"]), none, null).map((el) => el.id);
    // Sibling of the drag ("stranger", as host's child) and the host itself are
    // candidates; the stranger's internals are not, nor is anything deeper.
    expect(ids).toEqual(expect.arrayContaining(["host", "stranger", "top"]));
    expect(ids).not.toContain("sibA");
    expect(ids).not.toContain("deep");
  });

  it("keeps only what is inside the viewport", () => {
    const ids = snapCandidates(page, none, none, { x: 0, y: 0, width: 1000, height: 1000 }).map((el) => el.id);
    expect(ids).toEqual(expect.arrayContaining(["frame", "free"]));
    expect(ids).not.toContain("far");
  });

  it("answers through the same geometry the snapping math reads", () => {
    // The list carries a flat box, not a copy of the element. `calculateSnapping`
    // reads candidates through `elementAABB`, so a line keeps `dx`/`dy` to keep
    // answering through its own geometry.
    const line: DesignElement = { id: "line", type: "line", x: 40, y: 60, dx: -80, dy: -20, width: 80, height: 20 } as DesignElement;
    const list = snapCandidates([line], none, none, null);
    const snap = calculateSnapping({ x: 0, y: 0, width: 10, height: 10 }, 1, 2000, 2000, list);
    expect(snap.guides.length).toBeGreaterThan(0);
  });
});

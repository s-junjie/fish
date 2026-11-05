import { describe, it, expect } from "vitest";
import { calculateSnapping, calculateResizeSnapping } from "../src/core/geometry/snap-guides";
import { RectElement } from "../src/core/dsl/types";

describe("FISH Smart Snapping Guides", () => {
  const siblings: RectElement[] = [
    { id: "box1", type: "rect", x: 100, y: 100, width: 100, height: 100 }
  ];

  it("snaps to sibling left edge within threshold", () => {
    // dragging bounds near x=100 (e.g. 102)
    const res = calculateSnapping({ x: 102, y: 300, width: 50, height: 50 }, 1, 1080, 1080, siblings);
    expect(res.snappedX).toBe(100);
    expect(res.guides.some((g) => g.orientation === "vertical" && g.position === 100)).toBe(true);
  });

  it("snaps to sibling center X within threshold", () => {
    // box1 center is 150. target width 50, so target center is x + 25.
    // If target x is 123, target center is 148 (diff 2 <= 6)
    const res = calculateSnapping({ x: 123, y: 300, width: 50, height: 50 }, 1, 1080, 1080, siblings);
    expect(res.snappedX).toBe(125); // 150 - 25
    expect(res.guides.some((g) => g.position === 150)).toBe(true);
  });

  it("snaps to canvas horizontal and vertical centers", () => {
    // canvas center is 540; a box centred at 538 is within the 6px threshold
    const res2 = calculateSnapping({ x: 488, y: 488, width: 100, height: 100 }, 1, 1080, 1080, []);
    expect(res2.snappedX).toBe(490);
    expect(res2.snappedY).toBe(490);
  });

  it("holds the magnet at 6 SCREEN px, so a gap survives a deep zoom", () => {
    // 2 document units from the sibling's edge: inside the magnet at 100%
    // (2px), far outside it at 2000% (40 screen px).
    const box = { x: 98, y: 300, width: 50, height: 50 };
    expect(calculateSnapping(box, 1, 1080, 1080, siblings).snappedX).toBe(100);
    expect(calculateSnapping(box, 20, 1080, 1080, siblings).snappedX).toBe(98);
    expect(calculateSnapping(box, 20, 1080, 1080, siblings).guides).toHaveLength(0);
  });

  it("widens the reach in document units when zoomed out, never past the screen", () => {
    // 20 units away is 2 screen px at 10% — still under the hand's 6. The
    // nearest alignment is the target's right edge abutting the sibling's left
    // edge (delta 20) rather than the coincident left edges (delta 30).
    expect(calculateSnapping({ x: 70, y: 300, width: 50, height: 50 }, 0.1, 1080, 1080, siblings).snappedX).toBe(50);
    expect(calculateSnapping({ x: 70, y: 300, width: 50, height: 50 }, 1, 1080, 1080, siblings).snappedX).toBe(70);
  });

  it("the nearest candidate wins, not the last one listed", () => {
    // The reported defect: every sibling within reach overwrote the result, so
    // the later box at 103 won over the nearer one at 100.
    const near = [
      { id: "a", type: "rect", x: 100, y: 0, width: 40, height: 40 },
      { id: "b", type: "rect", x: 103, y: 200, width: 40, height: 40 }
    ] as RectElement[];
    const res = calculateSnapping({ x: 101, y: 300, width: 50, height: 50 }, 1, undefined, undefined, near);
    expect(res.snappedX).toBe(100);
    expect(res.guides.filter((g) => g.orientation === "vertical")).toHaveLength(1);
  });

  it("a losing canvas centre leaves no guide behind", () => {
    // The canvas centre is within reach but a sibling edge is nearer: the snap
    // must land on the sibling and the centre line must not be drawn.
    const res = calculateSnapping({ x: 94.5, y: 300, width: 10, height: 10 }, 1, 200, 200, [
      { id: "s", type: "rect", x: 94.8, y: 100, width: 20, height: 20 }
    ]);
    expect(res.snappedX).toBe(94.8);
    expect(res.guides.some((g) => g.position === 100)).toBe(false);
  });

  it("collinear guides merge into one segment", () => {
    const stacked = [
      { id: "a", type: "rect", x: 100, y: 0, width: 40, height: 40 },
      { id: "b", type: "rect", x: 100, y: 200, width: 40, height: 40 }
    ] as RectElement[];
    const res = calculateSnapping({ x: 102, y: 90, width: 50, height: 50 }, 1, undefined, undefined, stacked);
    const vertical = res.guides.filter((g) => g.orientation === "vertical");
    expect(vertical).toHaveLength(1);
    expect(vertical[0].position).toBe(100);
    expect(vertical[0].start).toBe(0);
    expect(vertical[0].end).toBe(240);
  });

  it("abuts the target's right edge onto a sibling's left edge", () => {
    const res = calculateSnapping({ x: 157, y: 300, width: 40, height: 40 }, 1, undefined, undefined, siblings);
    expect(res.snappedX).toBe(160);
    expect(res.guides.some((g) => g.orientation === "vertical" && g.position === 200)).toBe(true);
  });
});

describe("calculateResizeSnapping keeps anchored edges fixed", () => {
  const sibling: RectElement = { id: "sib", type: "rect", x: 100, y: 300, width: 80, height: 40 };

  it("snaps the right edge to a sibling's left edge without moving x (mr)", () => {
    const res = calculateResizeSnapping("mr", { x: 0, y: 300, width: 98, height: 40 }, 1, 800, 600, [sibling]);
    expect(res.x).toBe(0);
    expect(res.width).toBe(100);
    expect(res.guides.some((g) => g.orientation === "vertical" && g.position === 100)).toBe(true);
  });

  it("snaps the left edge but keeps the right edge anchored (ml)", () => {
    const res = calculateResizeSnapping("ml", { x: 98, y: 300, width: 100, height: 40 }, 1, 800, 600, [sibling]);
    expect(res.x).toBe(100);
    expect(res.x + res.width).toBe(198);
  });

  it("does not move the box when the anchored left edge is near a target (mr)", () => {
    const res = calculateResizeSnapping("mr", { x: 102, y: 300, width: 200, height: 40 }, 1, 800, 600, [sibling]);
    expect(res.x).toBe(102);
    expect(res.width).toBe(200);
    expect(res.guides).toHaveLength(0);
  });

  it("snaps the bottom edge to the canvas center without moving y (bm)", () => {
    const res = calculateResizeSnapping("bm", { x: 100, y: 210, width: 40, height: 92 }, 1, 800, 600, []);
    expect(res.y).toBe(210);
    expect(res.height).toBe(90);
  });

  it("snaps the top edge but keeps the bottom anchored (tm)", () => {
    const res = calculateResizeSnapping("tm", { x: 100, y: 198, width: 40, height: 100 }, 1, 800, 600, [
      { ...sibling, y: 200 }
    ]);
    expect(res.y).toBe(200);
    expect(res.y + res.height).toBe(298);
  });

  it("snaps a corner handle on both axes independently", () => {
    const res = calculateResizeSnapping("br", { x: 98, y: 298, width: 40, height: 40 }, 1, 800, 600, [sibling]);
    // right edge 138 => sibling right 140; bottom 338 => sibling bottom 340.
    expect(res.width).toBe(42);
    expect(res.height).toBe(42);
    expect(res.guides).toHaveLength(2);
  });

  it("leaves a 2-unit gap alone at a deep zoom (mr)", () => {
    // The reported defect: a box 24 x 24 around a 21.5 x 21.5 sibling at 1979%
    // snapped its edge onto the sibling's the moment it came within 6 units.
    const res = calculateResizeSnapping("mr", { x: 0, y: 300, width: 98, height: 40 }, 19.79, 800, 600, [
      sibling
    ]);
    expect(res.x).toBe(0);
    expect(res.width).toBe(98);
    expect(res.guides).toHaveLength(0);
  });
});

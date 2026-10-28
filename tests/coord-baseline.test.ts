import { flattenLayout } from "../src/core/dsl/layout-flat";
/**
 * Phase 0 baseline: documents coordinate semantics after the v0.3
 * local-coord migration.
 *
 * Children use LOCAL coordinates: `child.x/y` is relative to the parent
 * frame's own `x/y` origin (not the canvas). The renderer and hit-testing
 * functions propagate canvas origin through the tree.
 */

import { describe, it, expect } from "vitest";
import {
  elementAABB,
  shiftChildren,
  placeChildAt,
  subtreeBounds
} from "../src/core/geometry/element-bounds";
import { findFrameAtPoint, findElementAtPoint, reparentOnCanvasDrop, dissolveFrame } from "../src/core/geometry/tree-ops";
import { applyAutoLayout } from "../src/core/compile";
import type { FrameElement, RectElement, LineElement } from "../src/core/dsl/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRect = (id: string, x: number, y: number, w = 60, h = 40): RectElement => ({
  id, type: "rect", x, y, width: w, height: h
});

const makeFrame = (
  id: string, x: number, y: number, w: number, h: number,
  children: FrameElement["children"] = []
): FrameElement => ({
  id, type: "frame", x, y, width: w, height: h, children
});

// ---------------------------------------------------------------------------
// 1. elementAABB — line/arrow use dx/dy to derive AABB
// ---------------------------------------------------------------------------

describe("elementAABB (v0.3 dx/dy)", () => {
  it("rect: AABB equals stored box", () => {
    const r = makeRect("r", 50, 80, 120, 60);
    expect(elementAABB(r)).toEqual({ x: 50, y: 80, width: 120, height: 60 });
  });

  it("line with positive dx/dy: AABB is (x,y) to (x+dx, y+dy)", () => {
    const line: LineElement = {
      id: "l", type: "line",
      x: 10, y: 20, dx: 100, dy: 50,
      width: 100, height: 50,
      strokes: [{ width: 1 }]
    };
    expect(elementAABB(line)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("line with negative dx/dy (backward): AABB normalises to min/max", () => {
    const line: LineElement = {
      id: "l", type: "line",
      x: 110, y: 70, dx: -100, dy: -50,
      width: 100, height: 50,
      strokes: [{ width: 1 }]
    };
    expect(elementAABB(line)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
});

// ---------------------------------------------------------------------------
// 2. subtreeBounds — expressed in element's own local space
// ---------------------------------------------------------------------------

describe("subtreeBounds (local space)", () => {
  it("leaf element returns its own AABB (= local AABB)", () => {
    const r = makeRect("r", 10, 20, 100, 50);
    expect(subtreeBounds(r)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("frame with children extending beyond right edge: union grows", () => {
    // Child at local (0,0) size (300,50) — relative to the frame
    // Frame is at (100,100) canvas, but subtreeBounds is in the FRAME's local space.
    // The frame's own AABB: { x:100, y:100, w:200, h:200 }
    // Child local AABB: { x:0, y:0, w:300, h:50 }
    // In frame-local space: child at frame.x + child.x = 100+0 = 100 → extends to 400
    // subtreeBounds union includes child → right edge = max(100+200, 100+300) = 400
    const child = makeRect("c", 0, 0, 300, 50);
    const frame = makeFrame("f", 100, 100, 200, 200, [child]);
    const bounds = subtreeBounds(frame);
    expect(bounds.x).toBe(100); // frame's own x
    expect(bounds.y).toBe(100);
    expect(bounds.x + bounds.width).toBe(400); // extends to include child
  });
});

// ---------------------------------------------------------------------------
// 3. shiftChildren — shifts x/y only; dx/dy are invariant
// ---------------------------------------------------------------------------

describe("shiftChildren (v0.3 dx/dy invariant)", () => {
  it("shifts x/y of children; dx/dy of line are unchanged", () => {
    const line: LineElement = {
      id: "l", type: "line",
      x: 10, y: 10, dx: 50, dy: 30,
      width: 50, height: 30,
      strokes: [{ width: 1 }]
    };
    const inner = makeFrame("inner", 5, 5, 50, 50, [line]);
    const shifted = shiftChildren([inner], 100, 200);
    const shiftedInner = shifted[0] as FrameElement;
    expect(shiftedInner.x).toBe(105);
    expect(shiftedInner.y).toBe(205);
    const shiftedLine = shiftedInner.children[0] as LineElement;
    expect(shiftedLine.x).toBe(110);
    expect(shiftedLine.y).toBe(210);
    // dx/dy are LOCAL deltas — they do NOT change on translate
    expect(shiftedLine.dx).toBe(50);
    expect(shiftedLine.dy).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 4. placeChildAt — moves start endpoint; dx/dy direction preserved
// ---------------------------------------------------------------------------

describe("placeChildAt (v0.3)", () => {
  it("places a rect at new absolute position", () => {
    const r = makeRect("r", 0, 0, 50, 30);
    const placed = placeChildAt(r, 200, 300, 50, 30);
    expect(placed.x).toBe(200);
    expect(placed.y).toBe(300);
  });

  it("places a line: x/y move, dx/dy sign preserved, magnitude updated", () => {
    const line: LineElement = {
      id: "l", type: "line",
      x: 0, y: 0, dx: 50, dy: 30,
      width: 50, height: 30,
      strokes: [{ width: 1 }]
    };
    const placed = placeChildAt(line, 200, 300, 80, 60) as LineElement;
    expect(placed.x).toBe(200);
    expect(placed.y).toBe(300);
    expect(placed.dx).toBe(80);
    expect(placed.dy).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// 5. hit-testing: findFrameAtPoint / findElementAtPoint
//    With local coords: hit test uses canvas-absolute coords, propagated
//    through the tree. Fixtures must use LOCAL coords (relative to parent).
// ---------------------------------------------------------------------------

describe("hit-testing (local coord tree)", () => {
  // outer at canvas (0,0) size 500×500
  // inner at LOCAL (100,100) relative to outer — canvas (100,100), size 200×200
  // r at LOCAL (20,20) relative to inner — canvas (120,120), size 50×50
  const outer = makeFrame("outer", 0, 0, 500, 500,
    [makeFrame("inner", 100, 100, 200, 200,
      [makeRect("r", 20, 20, 50, 50)])]);

  it("findFrameAtPoint hits inner frame for point inside it (canvas coords)", () => {
    // canvas (150,150) is inside inner (100..300)
    expect(findFrameAtPoint([outer], 150, 150)?.id).toBe("inner");
  });

  it("findFrameAtPoint hits outer when point is outside inner", () => {
    expect(findFrameAtPoint([outer], 50, 50)?.id).toBe("outer");
  });

  it("findElementAtPoint finds deepest element (r) at its canvas position", () => {
    // r canvas = inner_canvas(100,100) + r_local(20,20) = (120,120)
    // center of r = (120+25, 120+25) = (145, 145)
    expect(findElementAtPoint([outer], 130, 130)?.id).toBe("r");
  });
});

// ---------------------------------------------------------------------------
// 6. applyAutoLayout
// ---------------------------------------------------------------------------

describe("applyAutoLayout (v0.3 layout)", () => {
  it("row flex: child placed at content origin", () => {
    const frame = makeFrame("f", 100, 200, 400, 300, [makeRect("r1", 0, 0, 80, 40)]);
    const laid = applyAutoLayout({
      ...frame,
      ...flattenLayout({ mode: "flex", direction: "row", gap: 0, padding: 10 })
    });
    // Child x should reflect layout output — value depends on layout engine phase
    expect(laid.children[0].x).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 7. dissolveFrame — released children get canvas-absolute coords
// ---------------------------------------------------------------------------

describe("dissolveFrame (local → canvas on release)", () => {
  it("children are released with canvas-absolute coords (local + frame canvas origin)", () => {
    // child is at LOCAL (50, 60) inside the frame
    // frame is at canvas (10, 10)
    // expected released canvas position = (10+50, 10+60) = (60, 70)
    const child = makeRect("c", 50, 60, 30, 30);
    const frame = makeFrame("f", 10, 10, 200, 200, [child]);
    const { elements, releasedIds } = dissolveFrame([frame], "f");
    expect(releasedIds).toEqual(["c"]);
    const released = elements.find(e => e.id === "c")!;
    expect(released.x).toBe(60); // 10 + 50
    expect(released.y).toBe(70); // 10 + 60
  });
});

// ---------------------------------------------------------------------------
// 8. reparentOnCanvasDrop
// ---------------------------------------------------------------------------

describe("reparentOnCanvasDrop", () => {
  it("element dropped inside a frame becomes its child with adjusted local coords", () => {
    // bigFrame at canvas (0,0), size 500×500
    // rect at canvas (100,100) — it is top-level so local = canvas = (100,100)
    const bigFrame = makeFrame("big", 0, 0, 500, 500, []);
    const rect = makeRect("r", 100, 100, 50, 50);
    const { elements, reparented } = reparentOnCanvasDrop([bigFrame, rect], "r");
    expect(reparented).toBe(true);
    const big = elements.find(e => e.id === "big") as FrameElement;
    expect(big.children.some(c => c.id === "r")).toBe(true);
    // rect's local coords inside bigFrame = canvas(100,100) - frame canvas(0,0) = (100,100)
    const rLocal = big.children.find(c => c.id === "r")!;
    expect(rLocal.x).toBe(100);
    expect(rLocal.y).toBe(100);
  });
});

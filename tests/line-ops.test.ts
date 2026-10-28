import { describe, it, expect } from "vitest";
import {
  elementAABB,
  isLineElement,
  moveElementTo,
  translateElement,
  setLineEndpoint,
  setLineSize,
  mirrorElement,
  placeChildAt
} from "../src/core/interactions/line-ops";
import { alignElements, nudgeElements } from "../src/core/interactions/alignment";
import { LineElement, ArrowElement, RectElement } from "../src/core/dsl/types";

// dx=160, dy=40 means the line runs from (100,100) to (260,140).
const line = (over: Partial<LineElement> = {}): LineElement => ({
  id: "l1",
  type: "line",
  x: 100,
  y: 100,
  dx: 160,
  dy: 40,
  width: 160,
  height: 40,
  strokes: [{ color: "#FFFFFF", width: 2 }],
  ...over
});

describe("Line/arrow endpoint geometry", () => {
  it("recognises line and arrow as line elements", () => {
    expect(isLineElement(line())).toBe(true);
    expect(isLineElement({ id: "a", type: "arrow", x: 0, y: 0, dx: 10, dy: 0, width: 10, height: 0, strokes: [{ color: "#fff", width: 1 }] } as ArrowElement)).toBe(true);
    expect(isLineElement({ id: "r", type: "rect", x: 0, y: 0, width: 10, height: 10 } as RectElement)).toBe(false);
  });

  it("computes the real AABB for reversed endpoints", () => {
    // A line at (260,140) with dx=-160, dy=-40 → runs from 260..100 and 140..100
    const reversed = line({ x: 260, y: 140, dx: -160, dy: -40 });
    expect(elementAABB(reversed)).toEqual({ x: 100, y: 100, width: 160, height: 40 });
  });

  it("translates start endpoint only; dx/dy stay the same", () => {
    const moved = moveElementTo(line(), 120, 130) as LineElement;
    expect(moved.x).toBe(120);
    expect(moved.y).toBe(130);
    // dx/dy unchanged — absolute end is now (120+160, 130+40) = (280, 170)
    expect(moved.dx).toBe(160);
    expect(moved.dy).toBe(40);
    expect(moved.width).toBe(160);

    const nudged = translateElement(line(), -10, 5) as LineElement;
    expect(nudged.x).toBe(90);
    expect(nudged.dx).toBe(160); // invariant
    expect(nudged.dy).toBe(40);
  });

  it("drags one endpoint and re-derives the box span", () => {
    // Moving the start to (0,0): absolute end stays at (100+160, 100+40) = (260, 140)
    // New dx = 260-0 = 260, dy = 140-0 = 140
    const start = setLineEndpoint(line(), "start", 0, 0);
    expect(start.x).toBe(0);
    expect(start.y).toBe(0);
    expect(start.dx).toBe(260);
    expect(start.dy).toBe(140);
    expect(start.width).toBe(260);
    expect(start.height).toBe(140);

    // Moving the end to (100, 100): new dx = 100-100 = 0, dy = 100-100 = 0
    const end = setLineEndpoint(line(), "end", 100, 100);
    expect(end.x).toBe(100);
    expect(end.dx).toBe(0);
    expect(end.dy).toBe(0);
    expect(end.width).toBe(0);
    expect(end.height).toBe(0);
  });

  it("resizes the span while preserving direction", () => {
    const grown = setLineSize(line(), 200, 80);
    // direction positive, so new dx=200, dy=80; absolute end = (100+200, 100+80) = (300, 180)
    expect(grown.dx).toBe(200);
    expect(grown.dy).toBe(80);

    // Reversed line: dx=-160, dy=-40 → direction negative
    const reversed = setLineSize(line({ x: 260, y: 140, dx: -160, dy: -40 }), 80, 20);
    // direction negative → new dx=-80, dy=-20; abs end = (260-80, 140-20) = (180, 120)
    expect(reversed.dx).toBe(-80);
    expect(reversed.dy).toBe(-20);
  });

  it("mirrors endpoints across an axis", () => {
    // Mirror horizontally (axis "h") around x=180
    // newX = 2*180 - x - dx = 360 - 100 - 160 = 100... wait
    // mirrorElement(line, "h", 180): the AABB is (100..260); mirrored AABB would be (100..260) → same
    // But the start flips: new_x = 2*180 - (x+dx) = 360 - 260 = 100; dx flips to -160
    const h = mirrorElement(line(), "h", 180) as LineElement;
    expect(h.x).toBe(100);   // the "old end" becomes the new start
    expect(h.dx).toBe(-160); // direction reversed

    // Mirror vertically (axis "v") around y=120
    // new start = 2*center - abs_end = 2*120 - (100+40) = 100; dy flips to -40
    const v = mirrorElement(line(), "v", 120) as LineElement;
    expect(v.y).toBe(100);
    expect(v.dy).toBe(-40);

    // Mirror at x=0: new_x = 2*0 - (100+160) = -260; dx flips to -160
    const offCenter = mirrorElement(line(), "h", 0) as LineElement;
    expect(offCenter.x).toBe(-260);
    expect(offCenter.dx).toBe(-160);
  });

  it("places a line child by moving start and preserving direction", () => {
    const placed = placeChildAt(line(), 0, 0, 160, 40) as LineElement;
    expect(placed.x).toBe(0);
    expect(placed.dx).toBe(160);  // positive direction preserved
    expect(placed.dy).toBe(40);

    const stretched = placeChildAt(line(), 0, 0, 320, 40) as LineElement;
    expect(stretched.dx).toBe(320);
  });
});

describe("Line-aware align and nudge", () => {
  const rect: RectElement = { id: "r1", type: "rect", x: 0, y: 200, width: 50, height: 50 };

  it("nudge moves the start endpoint; dx/dy unchanged", () => {
    const nudged = nudgeElements([line()], new Set(["l1"]), 5, -5, false);
    const moved = nudged[0] as LineElement;
    expect(moved.x).toBe(105);
    expect(moved.dx).toBe(160); // invariant
    expect(moved.dy).toBe(40);
  });

  it("left-align uses the endpoint AABB and keeps the segment intact", () => {
    // reversed: start at (260,140), dx=-160, dy=-40 → abs end (100, 100), AABB x=100
    const reversed = line({ x: 260, y: 140, dx: -160, dy: -40 });
    const aligned = alignElements([rect, reversed], "left");
    const moved = aligned[1] as LineElement;
    // AABB.x should be 0 (aligned to rect's left); direction (dx sign) preserved
    expect(elementAABB(moved).x).toBe(0);
    expect(moved.dx).toBe(-160); // direction preserved
  });
});

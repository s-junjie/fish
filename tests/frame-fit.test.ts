import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import {
  frameFitRefusal,
  resizeFrameToFit
} from "../src/core/interactions/frame-fit";
import { DesignElement, FrameElement, LineElement, RectElement } from "../src/core/dsl/types";
import { relayoutDocumentTree } from "../src/core/compile";

const rect = (id: string, x: number, y: number, w = 100, h = 50, rotation?: number): RectElement => ({
  id,
  type: "rect",
  x,
  y,
  width: w,
  height: h,
  ...(rotation !== undefined ? { rotation } : {})
});

const frame = (id: string, children: DesignElement[], extra: Partial<FrameElement> = {}): FrameElement => ({
  id,
  type: "frame",
  x: 0,
  y: 0,
  width: 400,
  height: 400,
  children,
  ...extra
});

describe("resize to fit", () => {
  it("shrinks the frame to the union of its children", () => {
    const f = frame("f1", [rect("a", 20, 30, 100, 50), rect("b", 200, 100, 60, 40)]);
    const next = resizeFrameToFit(f)!;
    expect([next.x, next.y, next.width, next.height]).toEqual([20, 30, 240, 110]);
  });

  it("leaves the children where they are on screen", () => {
    // The frame moved from (0,0) to (20,30), so every child must be re-based by
    // the same amount: the content must not shift on the canvas.
    const f = frame("f1", [rect("a", 20, 30, 100, 50), rect("b", 200, 100, 60, 40)]);
    const next = resizeFrameToFit(f)!;
    const byId = new Map((next.children || []).map((c) => [c.id, c]));
    expect([byId.get("a")!.x, byId.get("a")!.y]).toEqual([0, 0]);
    expect([byId.get("b")!.x, byId.get("b")!.y]).toEqual([180, 70]);
  });

  it("grows to cover children that hang off the top-left", () => {
    const f = frame("f1", [rect("a", -40, -20, 100, 50)]);
    const next = resizeFrameToFit(f)!;
    expect([next.x, next.y, next.width, next.height]).toEqual([-40, -20, 100, 50]);
    expect(next.children![0].x).toBe(0);
    expect(next.children![0].y).toBe(0);
  });

  it("covers a rotated child by its painted bounds", () => {
    // A 100x50 box at 90° paints 50x100 centred on its own centre, so it hangs
    // 25px off the top of its unrotated box. The frame has to cover that, and the
    // child has to keep its canvas position — which for a centred rotation means
    // it no longer starts at the frame's own origin.
    const f = frame("f1", [rect("a", 0, 0, 100, 50, 90)]);
    const next = resizeFrameToFit(f)!;
    expect([next.x, next.y, next.width, next.height]).toEqual([25, -25, 50, 100]);
    const child = next.children![0];
    expect([child.x + next.x, child.y + next.y]).toEqual([0, 0]);
  });

  it("keeps a line's segment, not its bounding box origin", () => {
    const line: LineElement = { id: "l1", type: "line", x: 40, y: 40, width: 60, height: 0, dx: 60, dy: 0, strokes: [{ color: "#FFFFFF", width: 1 }] };
    const next = resizeFrameToFit(frame("f1", [line]))!;
    expect([next.width, next.height]).toEqual([60, 1]);
  });

  it("returns the same object when the frame already fits", () => {
    const f = frame("f1", [rect("a", 0, 0, 400, 400)]);
    expect(resizeFrameToFit(f)).toBe(f);
  });

  it("refuses an auto-layout frame, an empty one and a leaf", () => {
    expect(frameFitRefusal(frame("f1", [rect("a", 0, 0)], { ...flattenLayout({ mode: "flex" }) }))).toBe("auto-layout");
    expect(frameFitRefusal(frame("f1", []))).toBe("empty");
    expect(frameFitRefusal(rect("a", 0, 0))).toBe("not-a-frame");
    expect(resizeFrameToFit(frame("f1", [rect("a", 0, 0)], { ...flattenLayout({ mode: "flex" }) }))).toBeNull();
  });

  it("survives a relayout — a fit frame is a valid frame, not a stale box", () => {
    const next = resizeFrameToFit(frame("f1", [rect("a", 20, 30, 100, 50)]))!;
    const after = relayoutDocumentTree([next])[0] as FrameElement;
    expect([after.width, after.height]).toEqual([100, 50]);
    expect(after.children![0].x).toBe(0);
  });
});

describe("resize to fit a turned line", () => {
  const line = (id: string, x: number, y: number, dx: number, dy: number, rotation: number): LineElement => ({
    id,
    type: "line",
    x,
    y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    dx,
    dy,
    rotation,
    strokes: []
  });

  it("fits the turned segment, not the turned box", () => {
    // A 100x100 diagonal turned onto its own direction paints a vertical segment
    // 141.42 tall and nothing wide, hanging straight down from (50, 50). Fitting
    // the turned BOX instead made the frame 141.42x141.42 and pulled it 20.71
    // further out on both axes — out to (29, 29). (The width is floored at 1.)
    const f = frame("f1", [line("l", 50, 50, 100, 100, 45)]);
    const next = resizeFrameToFit(f)!;
    expect([next.x, next.y, next.width, next.height]).toEqual([50, 50, 1, 141]);
  });

  it("keeps the line where it was on screen", () => {
    const f = frame("f1", [line("l", 50, 50, 0, 100, 45)]);
    const next = resizeFrameToFit(f)!;
    const l = (next.children || [])[0];
    // The envelope hangs 70.71 to the LEFT of the anchor, so the frame starts
    // there — and the anchor is re-based to put the artwork back at (50, 50).
    // Both are rounded, because a frame's box is written in whole pixels.
    expect([next.x, next.y, next.width, next.height]).toEqual([-21, 50, 71, 71]);
    expect([l.x, l.y]).toEqual([71, 0]);
  });
});

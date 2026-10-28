import { describe, it, expect } from "vitest";
import type { DesignElement } from "../src/core/dsl/types";
import {
  calculateVisibleViewport,
  isElementInViewport,
  computeVisibleElementIds
} from "../src/core/geometry/cull";
import { subtreeBounds } from "../src/core/geometry/element-bounds";
import { flattenElements } from "../src/core/geometry/tree-ops";

// Simulate the documented coordinate model: a frame stores its own position, and
// its children store LOCAL coordinates relative to the frame (the renderer wraps
// children in `translate(frame.x, frame.y)`). `subtreeBounds` therefore returns a
// child's LOCAL box, not a world box.

function farFrameWithImageChild(): DesignElement[] {
  return [
    {
      id: "frame1",
      type: "frame",
      name: "Frame",
      x: 5000,
      y: 3000,
      width: 400,
      height: 300,
      children: [
        {
          id: "img1",
          type: "rect",
          x: 10, // local to frame
          y: 20,
          width: 200,
          height: 150,
          fills: [{ type: "image", assetId: "a1", enabled: true }]
        } as DesignElement
      ]
    } as DesignElement
  ];
}

describe("def emission culling (frame-nested fills)", () => {
  it("old per-element local-bounds test would drop a nested image def on zoom", () => {
    const all = flattenElements(farFrameWithImageChild());
    // Zoom in (10x) and pan so the frame is centered in the viewport.
    const pan = { x: 960 - 5200 * 10, y: 540 - 3150 * 10 };
    const vp = calculateVisibleViewport(pan, 10, 1920, 1080, 200);

    const frame = all.find((e) => e.id === "frame1")!;
    const child = (frame as any).children[0] as DesignElement;

    // The top-level frame's world subtree bounds overlap the viewport → it renders.
    expect(isElementInViewport(subtreeBounds(frame), vp)).toBe(true);

    // But the child's LOCAL subtree bounds (~10,20) sit near the origin and do NOT
    // overlap the world viewport → the old per-element test mis-culls it.
    expect(isElementInViewport(subtreeBounds(child), vp)).toBe(false);
  });

  it("keeps the nested image def visible when its top-level frame is in view", () => {
    const all = flattenElements(farFrameWithImageChild());
    const pan = { x: 960 - 5200 * 10, y: 540 - 3150 * 10 };
    const vp = calculateVisibleViewport(pan, 10, 1920, 1080, 200);

    const visible = computeVisibleElementIds(all, vp, new Set());

    expect(visible.has("frame1")).toBe(true);
    expect(visible.has("img1")).toBe(true);
  });

  it("drops the nested def only when the whole top-level frame is off-screen", () => {
    const all = flattenElements(farFrameWithImageChild());
    // Default zoom=1, pan=0 → world viewport is near the origin; the frame at
    // (5000,3000) is far outside, so neither it nor its child should render.
    const vp = calculateVisibleViewport({ x: 0, y: 0 }, 1, 1920, 1080, 200);

    const visible = computeVisibleElementIds(all, vp, new Set());

    expect(visible.has("frame1")).toBe(false);
    expect(visible.has("img1")).toBe(false);
  });

  it("gates nested-frame descendants through the outer top-level frame", () => {
    const all: DesignElement[] = flattenElements([
      {
        id: "outer",
        type: "frame",
        name: "Outer",
        x: 5000,
        y: 3000,
        width: 700,
        height: 600,
        children: [
          {
            id: "inner",
            type: "frame",
            name: "Inner",
            x: 10, // local to outer
            y: 20,
            width: 300,
            height: 200,
            children: [
              {
                id: "img2",
                type: "rect",
                x: 5, // local to inner
                y: 5,
                width: 100,
                height: 80,
                fills: [{ type: "image", assetId: "a2", enabled: true }]
              } as DesignElement
            ]
          } as DesignElement
        ]
      } as DesignElement
    ] as DesignElement[]);

    const pan = { x: 960 - 5250 * 10, y: 540 - 3175 * 10 };
    const vp = calculateVisibleViewport(pan, 10, 1920, 1080, 200);

    const visible = computeVisibleElementIds(all, vp, new Set());

    expect(visible.has("outer")).toBe(true);
    expect(visible.has("inner")).toBe(true);
    expect(visible.has("img2")).toBe(true);
  });

  it("emits everything when no viewport box is provided", () => {
    const all = flattenElements(farFrameWithImageChild());
    const visible = computeVisibleElementIds(all, null, new Set());
    expect(visible.has("frame1")).toBe(true);
    expect(visible.has("img1")).toBe(true);
  });
});

import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { resizeElementWithConstraints, resizeContainerWithConstraints } from "../src/core/geometry/constraints";
import { parsePathData } from "../src/core/geometry/path-data";
import { ContainerElement, DesignElement, LineElement, PathElement, RectElement } from "../src/core/dsl/types";

/**
 * Children are stored in the FRAME's local space (LESSONS §4.2), so a child's `x`
 * is the distance to the frame's left edge and nothing more. The frame sits at
 * (100, 100) here to make that visible: a child at `x: 20` is 20px from the left
 * edge, not 120.
 */
const frame = (children: DesignElement[]): ContainerElement => ({
  id: "frame",
  type: "frame",
  x: 100,
  y: 100,
  width: 200,
  height: 200,
  children
});

const rect = (props: Partial<RectElement>): RectElement => ({
  id: "child",
  type: "rect",
  x: 0,
  y: 0,
  width: 50,
  height: 50,
  ...props
});

/** A right-triangle path filling a 100x50 box, drawn from a single `M`/`L` pair. */
const tri = (props: Partial<PathElement> = {}): PathElement => ({
  id: "child",
  type: "path",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  d: "M 0 0 L 100 0 L 100 50 Z",
  ...props
});

/** The path's own extents, read back from the data rather than from the box. */
const drawn = (el: DesignElement): { minX: number; minY: number; maxX: number; maxY: number } => {
  const parsed = parsePathData((el as PathElement).d);
  if (!parsed) throw new Error("unparseable d");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const a of parsed.anchors) {
    minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x); maxY = Math.max(maxY, a.y);
  }
  return { minX, minY, maxX, maxY };
};

const resizeFrame = (children: DesignElement[], next: Partial<ContainerElement>): ContainerElement =>
  resizeElementWithConstraints(frame(children), next) as ContainerElement;

describe("container resize applies child constraints", () => {
  it("left pin keeps the child anchored to the left edge", () => {
    const child = rect({ x: 20, y: 10, constraints: { horizontal: "left", vertical: "top" } });
    const out = resizeFrame([child], { width: 300, height: 260 });
    const c = out.children![0];
    expect(c.x).toBe(20);
    expect(c.y).toBe(10);
    expect(c.width).toBe(50);
  });

  it("right pin keeps the right distance fixed", () => {
    // right distance = 200 - (20 + 50) = 130
    const child = rect({ x: 20, y: 10, constraints: { horizontal: "right", vertical: "top" } });
    const out = resizeFrame([child], { width: 300 });
    const c = out.children![0];
    expect(c.x + c.width).toBe(300 - 130);
  });

  it("stretch (left+right) grows the child with the container", () => {
    const child = rect({ x: 20, y: 10, width: 50, constraints: { horizontal: "stretch" } });
    const out = resizeFrame([child], { width: 300 });
    const c = out.children![0];
    expect(c.x).toBe(20);
    expect(c.width).toBe(50 + 100);
  });

  it("stretch vertical (top+bottom) grows the child height", () => {
    const child = rect({ x: 20, y: 10, height: 50, constraints: { vertical: "stretch" } });
    const out = resizeFrame([child], { height: 260 });
    const c = out.children![0];
    expect(c.y).toBe(10);
    expect(c.height).toBe(50 + 60);
  });

  it("center pin keeps the child centered", () => {
    const child = rect({ x: 75, constraints: { horizontal: "center" } });
    const out = resizeFrame([child], { width: 300 });
    const c = out.children![0];
    // old center distance: 75+25 - 100 = 0; new center = 150
    expect(c.x + c.width / 2).toBe(150);
  });

  it("scale mode scales the child proportionally", () => {
    const child = rect({ x: 50, width: 100, constraints: { horizontal: "scale" } });
    const out = resizeFrame([child], { width: 400 });
    const c = out.children![0];
    // sx = 2: leftDist 50 -> 100; width 100 -> 200
    expect(c.x).toBe(100);
    expect(c.width).toBe(200);
  });

  it("a west-edge drag never changes a top-left child's distance from that corner", () => {
    // Dragging the west edge moves the frame's own origin (100 -> 80) and widens
    // it. A left-pinned child must keep its 20px from the left edge, so it travels
    // WITH the edge. Handing this function the frame's canvas box instead of its
    // size is what used to subtract the origin from a child that never had it, and
    // the child drifted off the corner by exactly the amount the frame moved.
    const child = rect({ x: 20, y: 10, constraints: { horizontal: "left", vertical: "top" } });
    const out = resizeContainerWithConstraints(
      frame([child]),
      { width: 200, height: 200 },
      { width: 240, height: 200 }
    );
    expect(out.children![0].x).toBe(20);
    expect(out.children![0].y).toBe(10);
  });

  it("a west-edge drag carries a right-pinned child to the moved right edge", () => {
    const child = rect({ x: 120, constraints: { horizontal: "right" } });
    // right distance = 200 - (120 + 50) = 30
    const out = resizeContainerWithConstraints(
      frame([child]),
      { width: 200, height: 200 },
      { width: 240, height: 200 }
    );
    expect(out.children![0].x).toBe(240 - 30 - 50);
  });

  it("recurses into nested non-flex containers", () => {
    const inner = {
      id: "inner",
      type: "frame",
      x: 20,
      y: 10,
      width: 100,
      height: 100,
      constraints: { horizontal: "stretch" },
      children: [rect({ id: "leaf", x: 10, y: 10, constraints: { horizontal: "right" } })]
    } as unknown as ContainerElement;
    const out = resizeFrame([inner], { width: 300 });
    const nested = out.children![0] as ContainerElement;
    expect(nested.width).toBe(200);
    // The leaf's right distance inside the inner frame (100 - (10+50) = 40) is kept
    // against the inner frame's new width.
    const leaf = nested.children[0];
    expect(leaf.x + leaf.width).toBe(200 - 40);
  });

  it("skips constraint math for flex containers", () => {
    const child = rect({ x: 20, constraints: { horizontal: "stretch" } });
    const container = { ...frame([child]), ...flattenLayout({ mode: "flex", direction: "row" }) } as unknown as ContainerElement;
    const out = resizeElementWithConstraints(container, { width: 300 });
    expect((out as ContainerElement).children![0].width).toBe(50);
  });

  it("multi-frame drag: measuring from the drag-start snapshot never drifts", () => {
    // right distance = 130, bottom distance = 140 relative to the 200x200 frame
    const child = rect({ x: 20, y: 10, constraints: { horizontal: "right", vertical: "bottom" } });
    const original = frame([child]);
    let last = original;
    for (const size of [220, 240, 260, 300]) {
      // Every frame re-derives children from the original snapshot, exactly
      // like the gesture handler does after the drift fix.
      last = resizeContainerWithConstraints(
        original,
        { width: 200, height: 200 },
        { width: size, height: size }
      );
    }
    const c = last.children![0];
    expect(c.x + c.width).toBe(300 - 130);
    expect(c.y + c.height).toBe(300 - 140);
  });

  it("multi-frame drag: scale mode from the snapshot matches a single application", () => {
    const child = rect({ x: 50, width: 100, constraints: { horizontal: "scale" } });
    const original = frame([child]);
    const final = resizeContainerWithConstraints(
      original,
      { width: 200, height: 200 },
      { width: 400, height: 200 }
    );
    let last = original;
    for (const w of [250, 300, 350, 400]) {
      last = resizeContainerWithConstraints(
        original,
        { width: 200, height: 200 },
        { width: w, height: 200 }
      );
    }
    expect(last.children![0].x).toBe(final.children![0].x);
    expect(last.children![0].width).toBe(final.children![0].width);
  });
});

/**
 * A path's box and its drawing are two different facts. `rect` / `ellipse` /
 * `polygon` rebuild their outline from `width` / `height` on every read, so for
 * them a box change *is* a shape change; `path` stores `d` beside the box and
 * nothing rescales it for free. These are the tests that say the box and the
 * drawing cannot drift apart — the bug is invisible in a box-only assertion,
 * which is why every constraint test above uses rects and none of them would
 * have caught it.
 */
describe("a constrained path scales its drawing with its box", () => {
  it("scale mode scales the path data, not just the box", () => {
    const child = tri({ x: 50, constraints: { horizontal: "scale" } });
    const out = resizeFrame([child], { width: 400 });
    const c = out.children![0] as PathElement;
    expect(c.width).toBe(200);
    // sx = 2, so every coordinate in the data doubles with the box.
    expect(drawn(c)).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 50 });
  });

  it("stretch mode scales the path data on the stretched axis only", () => {
    const child = tri({ x: 20, constraints: { horizontal: "stretch" } });
    const out = resizeFrame([child], { width: 300 });
    const c = out.children![0] as PathElement;
    expect(c.width).toBe(200);
    const box = drawn(c);
    expect(box.maxX).toBe(200);
    // The vertical axis was untouched, so the height must not have moved.
    expect(box.maxY).toBe(50);
  });

  it("a non-resizing pin leaves the path data byte-identical", () => {
    const child = tri({ x: 20, y: 10, constraints: { horizontal: "left", vertical: "top" } });
    const out = resizeFrame([child], { width: 300, height: 300 });
    expect((out.children![0] as PathElement).d).toBe(child.d);
  });

  it("keeps the drawing inside the box after a two-axis scale", () => {
    const child = tri({ constraints: { horizontal: "scale", vertical: "scale" } });
    const out = resizeFrame([child], { width: 300, height: 200 });
    const c = out.children![0] as PathElement;
    const box = drawn(c);
    expect(box.maxX).toBeLessThanOrEqual(c.width);
    expect(box.maxY).toBeLessThanOrEqual(c.height);
  });

  it("scales the path data of a nested path when its parent frame stretches", () => {
    const inner = {
      id: "inner",
      type: "frame",
      x: 20,
      y: 10,
      width: 100,
      height: 100,
      constraints: { horizontal: "stretch" },
      children: [tri({ id: "leaf", x: 0, y: 0, constraints: { horizontal: "stretch" } })]
    } as unknown as ContainerElement;
    const out = resizeFrame([inner], { width: 300 });
    const leaf = (out.children![0] as ContainerElement).children[0] as PathElement;
    // inner 100 -> 200, so the leaf's stretch doubles its 100 -> 200 as well.
    expect(leaf.width).toBe(200);
    expect(drawn(leaf).maxX).toBe(200);
  });

  it("leaves an unparseable path data untouched rather than blanking it", () => {
    const child = tri({ d: "not a path", constraints: { horizontal: "scale" } });
    const out = resizeFrame([child], { width: 400 });
    expect((out.children![0] as PathElement).d).toBe("not a path");
  });

  it("scales line endpoint deltas alongside the box", () => {
    const line: LineElement = {
      id: "child",
      type: "line",
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      dx: 100,
      dy: 50,
      strokes: [{ color: "#000", width: 1 }],
      constraints: { horizontal: "scale" }
    };
    const out = resizeFrame([line], { width: 400 });
    const l = out.children![0] as LineElement;
    expect(l.width).toBe(200);
    expect(l.dx).toBe(200);
    expect(l.dy).toBe(50);
  });
});

describe("typing a width into the inspector scales a path's drawing", () => {
  it("resizes the data as well as the box", () => {
    const out = resizeElementWithConstraints(tri(), { width: 200 }) as PathElement;
    expect(out.width).toBe(200);
    expect(drawn(out).maxX).toBe(200);
  });
});

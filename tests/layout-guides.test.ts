import { describe, expect, it } from "vitest";
import type { LayoutGuide } from "../src/core/dsl/types";
import {
  DEFAULT_GUIDE_COLOR,
  guideGeometry,
  guidePatternPaint,
  guideSnapLines,
  guideSummary,
  snapPointToGuides,
  withLayoutGuides
} from "../src/core/layout/layout-guides";
import { calculateSnapping } from "../src/core/geometry/snap-guides";

const box = { width: 1200, height: 800 };

const bands = (guide: LayoutGuide, b = box) => {
  const geometry = guideGeometry(guide, b);
  if (geometry.kind !== "bands") throw new Error(`expected bands, got ${geometry.kind}`);
  return geometry;
};

describe("layout guide geometry", () => {
  it("divides a stretched box: margin insets the set, gutter sits between bands", () => {
    const { rects, bandSize } = bands({ kind: "columns", count: 5, gutter: 20 });
    // (1200 - 4*20) / 5
    expect(bandSize).toBe(224);
    expect(rects).toHaveLength(5);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: 224, height: 800 });
    expect(rects[1].x).toBe(244);
    expect(rects[4].x + rects[4].width).toBe(1200);
  });

  it("insets both sides along the measured axis, and leaves the other axis alone", () => {
    const { rects, bandSize } = bands({ kind: "columns", count: 5, gutter: 20, margin: 40 });
    // (1200 - 80 - 4*20) / 5
    expect(bandSize).toBe(208);
    // A column band runs the FULL height: its margin is left/right only.
    expect(rects[0]).toEqual({ x: 40, y: 0, width: 208, height: 800 });
  });

  it("insets only the starting side when the set is fixed", () => {
    const start = bands({ kind: "columns", count: 3, width: 200, gutter: 10, align: "start", margin: 40 });
    expect(start.rects[0].x).toBe(40);
    expect(start.bandSize).toBe(200);

    const end = bands({ kind: "columns", count: 3, width: 200, gutter: 10, align: "end", margin: 40 });
    // 3*200 + 2*10 = 620, so the last band ends at 1200 - 40.
    expect(end.rects[2].x + 200).toBe(1160);

    const center = bands({ kind: "columns", count: 3, width: 200, gutter: 10, align: "center", margin: 40 });
    // 40 + (1120 - 620) / 2
    expect(center.rects[0].x).toBe(290);
  });

  it("turns the same arithmetic on its side for rows", () => {
    const { rects, bandSize } = bands({ kind: "rows", count: 3, gutter: 16, margin: 8 });
    // (800 - 16 - 2*16) / 3
    expect(bandSize).toBeCloseTo(752 / 3, 9);
    // A row band runs the FULL width: its margin is top/bottom only.
    expect(rects[0].x).toBe(0);
    expect(rects[0].width).toBe(1200);
    expect(rects[0].y).toBe(8);
    expect(rects[1].y).toBeCloseTo(8 + 752 / 3 + 16, 9);
  });

  it("counts grid cells from the box instead of storing a count", () => {
    const geometry = guideGeometry({ kind: "grid", size: 8 }, { width: 1440, height: 900 });
    expect(geometry).toEqual({ kind: "cells", columns: 180, rows: 112, size: 8 });
  });

  it("returns nothing to draw for every degenerate combination", () => {
    expect(guideGeometry({ kind: "columns", count: 0 }, box).kind).toBe("none");
    expect(guideGeometry({ kind: "columns", count: 5, margin: 600 }, box).kind).toBe("none");
    // 5 bands of 0 or less: four 400px gutters already exceed the box.
    expect(guideGeometry({ kind: "columns", count: 5, gutter: 400 }, box).kind).toBe("none");
    expect(guideGeometry({ kind: "columns", count: 3, align: "start" }, box).kind).toBe("none");
    expect(guideGeometry({ kind: "grid", size: 0 }, box).kind).toBe("none");
    expect(guideGeometry({ kind: "columns", count: 5 }, { width: 0, height: 800 }).kind).toBe("none");
  });

  it("summarises in the panel's vocabulary, and names a grid by its pitch", () => {
    expect(guideSummary({ kind: "columns", count: 5 }, box)).toEqual({
      key: "layoutGuide.summary.columns",
      vars: { count: 5 }
    });
    expect(guideSummary({ kind: "rows", count: 3 }, box)).toEqual({
      key: "layoutGuide.summary.rows",
      vars: { count: 3 }
    });
    // The pitch, not the cell count: a count is a fact about the box.
    expect(guideSummary({ kind: "grid", size: 8 }, { width: 800, height: 800 })).toEqual({
      key: "layoutGuide.summary.grid",
      vars: { size: 8 }
    });
  });
});

describe("applying a saved ruler", () => {
  it("copies the guides onto the element and drops the key when empty", () => {
    const el = { id: "f", type: "frame", x: 0, y: 0, width: 100, height: 100 } as any;
    const saved: LayoutGuide[] = [{ kind: "columns", count: 5, gutter: 20 }];

    const next = withLayoutGuides(el, saved) as any;
    expect(next.layoutGuides).toEqual(saved);
    // Copied, not shared: editing the frame must not reach back into the style.
    expect(next.layoutGuides).not.toBe(saved);
    expect(next.layoutGuides[0]).not.toBe(saved[0]);
    // And the element it came from is untouched.
    expect(el.layoutGuides).toBeUndefined();

    expect((withLayoutGuides(next, []) as any).layoutGuides).toBeUndefined();
  });
});

describe("a grid guide is a pattern paint", () => {
  it("materialises as the tiling the pattern serializer already draws", () => {
    expect(guidePatternPaint({ kind: "grid", size: 8, color: "#FF00001A" })).toEqual({
      type: "pattern",
      motif: "grid",
      tile: { width: 8, height: 8 },
      weight: 1,
      foreground: "#FF00001A"
    });
  });

  it("falls back to the colour Figma's panel opens with", () => {
    expect(guidePatternPaint({ kind: "grid", size: 12 }).foreground).toBe(DEFAULT_GUIDE_COLOR);
  });
});

describe("snapping to guides", () => {
  const guided = [
    {
      id: "hero",
      type: "frame",
      x: 100,
      y: 50,
      width: 600,
      height: 400,
      layoutGuides: [{ kind: "columns", count: 2, gutter: 0, margin: 0 }]
    }
  ] as any;

  it("lists band edges in WORLD coordinates, not frame-local ones", () => {
    const lines = guideSnapLines(guided, "hero");
    // Two 300px bands, so edges at 0 / 300 / 600 local → 100 / 400 / 700 world.
    expect(lines.vertical.map((s) => s.position)).toEqual([100, 400, 400, 700]);
    expect(lines.vertical[0].start).toBe(50);
    expect(lines.vertical[0].end).toBe(450);
    expect(lines.horizontal).toEqual([]);
  });

  it("turns a grid's pitch into lines — that is what an 8pt grid is for", () => {
    const grid = [{ id: "g", type: "frame", x: 0, y: 0, width: 24, height: 16, layoutGuides: [{ kind: "grid", size: 8 }] }] as any;
    const lines = guideSnapLines(grid, "g");
    expect(lines.vertical.map((s) => s.position)).toEqual([0, 8, 16, 24]);
    expect(lines.horizontal.map((s) => s.position)).toEqual([0, 8, 16]);
  });

  it("snaps the point a new shape is drawn from, on each axis independently", () => {
    const lines = guideSnapLines(guided, "hero");
    expect(snapPointToGuides(lines, { x: 396, y: 90 }, 6)).toEqual({ x: 400, y: 90 });
    expect(snapPointToGuides(lines, { x: 200, y: 90 }, 6)).toEqual({ x: 200, y: 90 });
  });

  it("ignores every frame but the one the gesture is inside", () => {
    // Two artboards, each with a two-column ruler. Dragging inside "hero" must
    // not be pulled onto "next" — a neighbour's grid is a different drawing.
    const page = [
      { id: "hero", type: "frame", x: 0, y: 0, width: 200, height: 100, layoutGuides: [{ kind: "columns", count: 2, gutter: 0 }] },
      { id: "next", type: "frame", x: 400, y: 0, width: 200, height: 100, layoutGuides: [{ kind: "columns", count: 2, gutter: 0 }] }
    ] as any;
    expect(guideSnapLines(page, "hero").vertical.map((s) => s.position)).toEqual([0, 100, 100, 200]);
    expect(guideSnapLines(page).vertical).toEqual([]);
  });

  it("draws a grid at one screen pixel whatever the zoom", () => {
    expect(guidePatternPaint({ kind: "grid", size: 8 }, 1).weight).toBe(1);
    expect(guidePatternPaint({ kind: "grid", size: 8 }, 8).weight).toBe(0.125);
    expect(guidePatternPaint({ kind: "grid", size: 8 }, 0.5).weight).toBe(2);
  });

  it("pulls a moving box onto a band edge", () => {
    const lines = guideSnapLines(guided, "hero");
    const snap = calculateSnapping({ x: 397, y: 20, width: 100, height: 40 }, 1, 1200, 900, [], lines);
    expect(snap.snappedX).toBe(400);
    expect(snap.guides.some((g) => g.orientation === "vertical" && g.position === 400)).toBe(true);
  });
});

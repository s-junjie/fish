import { describe, it, expect } from "vitest";
import {
  parsePathData,
  serializePathData,
  moveAnchor,
  getAnchorMirrorMode,
  setAnchorMirrorMode
} from "../src/core/geometry/path-data";
import { parseIconBody } from "../src/core/assets/svg-body";
import lucideFixture from "./fixtures/iconify-lucide.json";
import remixFixture from "./fixtures/iconify-ri.json";

/** Every glyph in the fixtures, as the converter hands it to the canvas. */
const ICON_GEOMETRY: ReadonlyArray<readonly [string, string]> = Object.entries({
  ...(lucideFixture as { icons: Record<string, { body: string }> }).icons,
  ...(remixFixture as { icons: Record<string, { body: string }> }).icons
})
  .map(([name, icon]) => {
    const g = parseIconBody(icon.body);
    return g ? ([name, g.d] as const) : null;
  })
  .filter((pair): pair is readonly [string, string] => pair !== null);

describe("path-data serialization & mutation", () => {
  it("parses and serializes lines correctly", () => {
    const d = "M 10 20 L 50 60 L 90 20 Z";
    const parsed = parsePathData(d);
    expect(parsed).not.toBeNull();
    expect(parsed?.anchors).toHaveLength(3);
    expect(parsed?.closed).toBe(true);

    const serialized = serializePathData(parsed!);
    expect(serialized).toBe("M 10 20 L 50 60 L 90 20 Z");
  });

  it("moves an anchor and correctly updates connected cubic control points", () => {
    const d = "M 0 0 C 10 20 30 40 50 50";
    const parsed = parsePathData(d)!;
    expect(parsed.anchors).toHaveLength(2);

    // Move anchor 0 by dx=+5, dy=+10
    const moved = moveAnchor(parsed, 0, 5, 10);
    expect(moved.anchors[0]).toEqual({ x: 5, y: 10 });
    const seg = moved.segments[0];
    if (seg.kind === "cubic") {
      expect(seg.ca).toEqual({ x: 15, y: 30 }); // 10+5, 20+10
      expect(seg.cb).toEqual({ x: 30, y: 40 }); // untouched since it belongs to b
    } else {
      expect.fail("Expected cubic segment");
    }
  });

  it("cycles mirror modes none -> angle -> all and back via geometry change", () => {
    const d = "M 0 0 L 200 0 L 200 140 L 0 140 Z";
    const parsed = parsePathData(d)!;
    const anchorIdx = 0;
    expect(getAnchorMirrorMode(parsed, anchorIdx)).toBe("none");

    const angle = setAnchorMirrorMode(parsed, anchorIdx, "angle");
    expect(getAnchorMirrorMode(angle, anchorIdx)).toBe("angle");

    const all = setAnchorMirrorMode(parsed, anchorIdx, "all");
    expect(getAnchorMirrorMode(all, anchorIdx)).toBe("all");

    // Clicking "No mirroring" on a mirrored anchor must visibly detach handles
    const none = setAnchorMirrorMode(all, anchorIdx, "none");
    expect(getAnchorMirrorMode(none, anchorIdx)).toBe("none");

    // After decoupling, "Mirror angle" must re-engage angle mirroring
    expect(getAnchorMirrorMode(setAnchorMirrorMode(none, anchorIdx, "angle"), anchorIdx)).toBe("angle");
  });
});

describe("path-data arc parsing", () => {
  it("parses arcs with compact unseparated flags", () => {
    // laf=0, sf=1, then x=12.67 y=19 — flags written as "01"
    const path = parsePathData("M14.086 18.412A2 2 0 0112.67 19H5");
    expect(path).not.toBeNull();
    expect(path!.anchors[0]).toEqual({ x: 14.086, y: 18.412 });
    // the arc may split into several cubics; its endpoint must exist as an anchor
    expect(path!.anchors.some((a) => a.x === 12.67 && a.y === 19)).toBe(true);
    expect(path!.anchors.at(-1)).toEqual({ x: 5, y: 19 });
    // the arc became cubics, the H became a line
    expect(path!.segments.some((s) => s.kind === "cubic")).toBe(true);
    expect(path!.segments.at(-1)!.kind).toBe("line");
  });

  it("converts an arc endpoint-to-endpoint into on-curve cubics", () => {
    const path = parsePathData("M0 0A5 5 0 0 1 10 0");
    expect(path).not.toBeNull();
    const segs = path!.segments;
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs.every((s) => s.kind === "cubic")).toBe(true);
    expect(path!.anchors.at(-1)).toEqual({ x: 10, y: 0 });
    for (const s of segs) {
      if (s.kind === "cubic") {
        expect(s.ca.x).toBeGreaterThanOrEqual(-0.01);
        expect(s.cb.x).toBeLessThanOrEqual(10.01);
      }
    }
  });

  it("preserves closure through parse", () => {
    const path = parsePathData("M2 17A2 2 0 0 1 4 15H20A2 2 0 0 1 22 17Z");
    expect(path).not.toBeNull();
    expect(path!.closed).toBe(true);
  });

  it("reflects smooth cubic (S) controls", () => {
    const path = parsePathData("M0 0C1 1 2 1 3 0S5 -1 6 0");
    expect(path).not.toBeNull();
    expect(path!.segments.length).toBe(2);
    const second = path!.segments[1];
    expect(second.kind).toBe("cubic");
    if (second.kind === "cubic") {
      // reflection of (2,1) about (3,0) = (4,-1)
      expect(second.ca.x).toBeCloseTo(4, 5);
      expect(second.ca.y).toBeCloseTo(-1, 5);
    }
  });

  it("reflects smooth quadratic (T) controls", () => {
    const path = parsePathData("M0 0Q2 2 4 0T8 0");
    expect(path).not.toBeNull();
    expect(path!.segments.length).toBe(2);
    const second = path!.segments[1];
    expect(second.kind).toBe("quad");
    if (second.kind === "quad") {
      // reflection of (2,2) about (4,0) = (6,-2)
      expect(second.c.x).toBeCloseTo(6, 5);
      expect(second.c.y).toBeCloseTo(-2, 5);
    }
  });
});

describe("path-data round-trip stability", () => {
  it("is idempotent for every fixture icon (edit never degrades)", () => {
    expect(ICON_GEOMETRY.length).toBeGreaterThanOrEqual(30);
    for (const [name, d] of ICON_GEOMETRY) {
      const first = parsePathData(d);
      expect(first, name).not.toBeNull();
      const d1 = serializePathData(first!);
      expect(d1, name).not.toContain("NaN");
      const second = parsePathData(d1);
      const d2 = serializePathData(second!);
      expect(d2, `${name} round-trip drifted`).toBe(d1);
      expect(first!.anchors.length, `${name} anchor count changed`).toBe(second!.anchors.length);
    }
  });

  it("does not add a closepath to a path that already ends on its start", () => {
    // The shape Figma and the showcase document export: the last curve lands back on
    // the moveto point and the `Z` closes it. The parser drops that duplicate final
    // anchor and marks the real segment to emit `Z` after itself — so the serializer
    // must not ALSO emit its own trailing `Z`, or every pass through the pair appends
    // another one. Lucide's icons all close from somewhere other than their start,
    // which is why the idempotence test above never reached this branch.
    const d = "M 10 17 C 8 15 2 12 2 8 C 2 5 4 4 6 4 C 8 4 9 5 10 6.5 C 11 5 12 4 14 4 C 16 4 18 5 18 8 C 18 12 12 15 10 17 Z";
    const first = serializePathData(parsePathData(d)!);
    expect(first).not.toContain("Z Z");
    expect(first.match(/Z/g)).toHaveLength(1);
    expect(serializePathData(parsePathData(first)!)).toBe(first);
  });
});

import { describe, it, expect } from "vitest";
import { computeVisibleElementIds } from "../src/core/geometry/cull";
import { TextElement, PathElement } from "../src/core/dsl/types";
import { projectOffsetAlongTangent } from "../src/ui/hooks/canvas-gestures/drag-apply";
import { onPathGuide, onPathRunText } from "../src/core/geometry/on-path";
import { reversePathData, parsePathData } from "../src/core/geometry/path-data";

const viewport = { x: 0, y: 0, width: 1000, height: 800 };

const pathEl: PathElement = {
  id: "path_1",
  type: "path",
  name: "Arc",
  x: 100,
  y: 100,
  width: 400,
  height: 200,
  d: "M 100 100 C 200 0, 400 0, 500 100"
} as PathElement;

function textOnPath(id: string, box: { x: number; y: number; width: number; height: number }): TextElement {
  return {
    id,
    type: "text",
    name: "On path",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    content: "Hello",
    style: { fontSize: 24, fontFamily: "Inter", fontWeight: 400, color: "#FFFFFF" },
    onPath: { pathId: "path_1", startOffset: 0 }
  } as TextElement;
}

describe("on-path text culling", () => {
  it("keeps an on-path text whose stored box sits outside the viewport", () => {
    // The stored box can lag behind the painted glyphs (measured after render),
    // and a culled element can never be measured — so it must never be culled.
    const text = textOnPath("text_1", { x: -5000, y: -5000, width: 10, height: 10 });
    const visible = computeVisibleElementIds([pathEl, text], viewport, new Set());
    expect(visible.has("text_1")).toBe(true);
  });

  it("keeps an on-path text culled decision independent of its root's box", () => {
    const text = textOnPath("text_2", { x: 2000, y: 2000, width: 10, height: 10 });
    const visible = computeVisibleElementIds([text], viewport, new Set());
    expect(visible.has("text_2")).toBe(true);
  });

  it("still culls a straight text outside the viewport", () => {
    const straight = {
      id: "text_3",
      type: "text",
      name: "Straight",
      x: 5000,
      y: 5000,
      width: 100,
      height: 30,
      content: "Hi",
      style: { fontSize: 24, fontFamily: "Inter", fontWeight: 400, color: "#FFFFFF" }
    } as TextElement;
    const visible = computeVisibleElementIds([straight], viewport, new Set());
    expect(visible.has("text_3")).toBe(false);
  });
});

describe("on-path slide projection", () => {
  it("increases the offset when dragging along the tangent", () => {
    // Tangent points +x, path 1000px long: 100px of drag = 10%.
    const next = projectOffsetAlongTangent(10, 100, 0, 2, 0, 1000);
    expect(next).toBeCloseTo(20, 5);
  });

  it("decreases the offset when dragging against the tangent", () => {
    const next = projectOffsetAlongTangent(50, -50, 0, 1, 0, 1000);
    expect(next).toBeCloseTo(45, 5);
  });

  it("ignores drag perpendicular to the tangent", () => {
    const next = projectOffsetAlongTangent(50, 0, 80, 1, 0, 1000);
    expect(next).toBeCloseTo(50, 5);
  });

  it("clamps to 0 and 100", () => {
    expect(projectOffsetAlongTangent(1, -9999, 0, 1, 0, 1000)).toBe(0);
    expect(projectOffsetAlongTangent(99, 9999, 0, 1, 0, 1000)).toBe(100);
  });
});

/**
 * `side` is SVG2's own attribute and Chromium does not honour it, so "inside" is
 * done by reversing the guide and the string together. These pin the two halves
 * that have to agree, plus the reversal they are built on.
 */
describe("Text on Path: which side of the shape the run sits on", () => {
  const ellipse = {
    id: "ring",
    type: "ellipse" as const,
    x: 0,
    y: 0,
    width: 200,
    height: 100
  };
  const ringText = (side?: "in" | "out") =>
    ({
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      content: "GAUGE",
      style: { fontFamily: "Inter", fontSize: 12, color: "#000" },
      onPath: { pathId: "ring", ...(side ? { side } : {}) }
    }) as TextElement;

  it("leaves an absent side on the outside", () => {
    // Absent is the pre-`side` document, and it is what every saved file means.
    expect(onPathGuide([ellipse, ringText()], ringText())).toEqual(
      onPathGuide([ellipse, ringText("out")], ringText("out"))
    );
    expect(onPathRunText(ringText(), onPathGuide([ellipse, ringText()], ringText()))).toBe("GAUGE");
  });

  it("traverses the guide the other way for `in`", () => {
    const out = onPathGuide([ellipse, ringText("out")], ringText("out"))!;
    const inside = onPathGuide([ellipse, ringText("in")], ringText("in"))!;
    expect(inside.d).not.toBe(out.d);
    expect(inside.reversed).toBe(true);
    expect(out.reversed).toBe(false);
  });

  it("flips the run with the guide so it still reads forwards", () => {
    // Reversing only the path puts the glyphs on the other side AND reads the
    // string backwards along the curve, which is the whole reason the string
    // reversal exists.
    const inside = onPathGuide([ellipse, ringText("in")], ringText("in"))!;
    expect(onPathRunText(ringText("in"), inside)).toBe("EGUAG");
    expect(onPathRunText(ringText("in"), inside).split("").reverse().join("")).toBe("GAUGE");
  });

  it("splits an emoji by code point, not by UTF-16 unit", () => {
    const withEmoji = { ...ringText("in"), content: "A😀B" } as TextElement;
    const guide = onPathGuide([ellipse, withEmoji], withEmoji)!;
    expect(onPathRunText(withEmoji, guide)).toBe("B\u{1F600}A");
    expect(onPathRunText(withEmoji, guide)).not.toContain("\uFFFD");
  });

  it("renders the outside rather than a side nobody asked for", () => {
    // A two-subpath guide cannot be reversed faithfully, so `in` degrades to
    // `out` — and, critically, the string does NOT get flipped, which would draw
    // the text backwards with nothing to indicate why.
    const twoSubpaths = {
      id: "multi",
      type: "path" as const,
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      d: "M 0 0 L 10 0 M 20 20 L 30 20"
    } as PathElement;
    const el = { ...ringText("in"), onPath: { pathId: "multi", side: "in" as const } } as TextElement;
    const guide = onPathGuide([twoSubpaths, el], el)!;
    expect(guide.reversed).toBe(false);
    expect(onPathRunText(el, guide)).toBe("GAUGE");
  });

  it("has no guide for a text element that is not on a path, or whose target is gone", () => {
    const bare = { ...ringText("in"), onPath: undefined } as TextElement;
    expect(onPathGuide([ellipse, bare], bare)).toBeNull();
    // A dangling pathId: the guide is what renders the run, so with no target
    // there is nothing to hang it on.
    expect(onPathGuide([], ringText("in"))).toBeNull();
  });
});

describe("reversePathData", () => {
  const anchorsOf = (d: string | null) =>
    d ? (parsePathData(d)?.anchors ?? []).map((a) => [a.x, a.y] as const) : null;
  // The reversal re-serializes, which rounds to 2dp, so the comparison is
  // numeric. String equality would fail on the last decimal of any arc.
  const near = (a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]) =>
    a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 0.01 && Math.abs(p[1] - b[i][1]) < 0.01);

  it("visits the same points, in the opposite direction, from the same start", () => {
    for (const d of [
      "M 0 0 H 100 V 50 H 0 Z",
      "M 50 0 A 50 25 0 1 1 50 50 A 50 25 0 1 1 50 0 Z",
      "M 8 0 H 92 A 8 8 0 0 1 100 8 V 42 A 8 8 0 0 1 92 50 H 8 A 8 8 0 0 1 0 42 V 8 A 8 8 0 0 1 8 0 Z"
    ]) {
      const before = anchorsOf(d)!;
      const after = anchorsOf(reversePathData(d))!;
      // A closed path is a cycle, so anchor 0 has to stay first: `startOffset`
      // is measured from the start, and rotating the run would move the text
      // along with the flip the reversal is supposed to cause.
      expect(after[0][0], d).toBeCloseTo(before[0][0]);
      expect(near([...after.slice(1), after[0]], [...before].reverse()), d).toBe(true);
    }
  });

  it("starts an open path from the other end", () => {
    expect(anchorsOf(reversePathData("M 0 0 L 10 0 L 10 10"))).toEqual([
      [10, 10],
      [10, 0],
      [0, 0]
    ]);
  });

  it("is its own inverse, closed and open alike", () => {
    for (const d of ["M 0 0 H 100 V 50 H 0 Z", "M 0 0 L 10 0 L 10 10", "M 0 0 C 10 0 20 10 20 20"]) {
      const twice = reversePathData(reversePathData(d)!);
      expect(anchorsOf(twice), d).toEqual(anchorsOf(d));
    }
  });

  it("swaps a cubic's control handles", () => {
    // Reversed without swapping them, the curve bends the other way: same
    // anchors, different shape, which no anchor comparison would catch.
    const after = parsePathData(reversePathData("M 0 0 C 10 0 20 10 20 20")!)!;
    expect(after.segments[0]).toMatchObject({
      kind: "cubic",
      ca: { x: 20, y: 10 },
      cb: { x: 10, y: 0 }
    });
  });

  it("refuses what it cannot reverse faithfully", () => {
    // Two subpaths and a single point are the cases where a plausible-looking
    // answer would be wrong.
    expect(reversePathData("M 0 0 L 10 0 M 20 20 L 30 20"), "two subpaths").toBeNull();
    expect(reversePathData("M 5 5"), "single point").toBeNull();
    expect(reversePathData(""), "empty").toBeNull();
  });
});

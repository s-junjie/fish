import { describe, it, expect } from "vitest";
import { layoutTextRun, TextLayoutInput } from "../src/core/text-layout";

// No DOM here, so `measureText` uses its analytic fallback: 0.6em per glyph.
// At `fontSize: 10` that is exactly 6px a character, which is why every width
// below is a round number.
const run = (over: Partial<TextLayoutInput> = {}): TextLayoutInput => ({
  content: "hello",
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  fontSize: 10,
  fontFamily: "Inter, sans-serif",
  fontWeight: 400,
  lineHeight: 12,
  letterSpacing: 0,
  align: "left",
  verticalAlign: "top",
  ...over
});

describe("lines", () => {
  it("keeps a run that fits on one line", () => {
    expect(layoutTextRun(run({ content: "hello" })).lines).toEqual(["hello"]);
  });

  it("breaks at a space when the line is too wide", () => {
    // 14 characters is 84px in a 60px box: the break lands after the second word.
    expect(layoutTextRun(run({ content: "aaaa bbbb cccc", width: 60 })).lines).toEqual([
      "aaaa bbbb ",
      "cccc"
    ]);
  });

  it("treats an explicit newline as a hard break", () => {
    expect(layoutTextRun(run({ content: "a\nb" })).lines).toEqual(["a", "b"]);
  });

  it("keeps a blank line as a line", () => {
    expect(layoutTextRun(run({ content: "a\n\nb" })).lines).toEqual(["a", "", "b"]);
  });

  it("applies text-transform before it measures", () => {
    expect(layoutTextRun(run({ content: "ab", textTransform: "uppercase" })).lines).toEqual(["AB"]);
  });
});

describe("the clamp", () => {
  it("cuts to maxLines and adds an ellipsis only when something was dropped", () => {
    const cut = layoutTextRun(run({ content: "hello world", width: 60, maxLines: 1, textOverflow: "ellipsis" }));
    expect(cut.lines).toEqual(["hello wor\u2026"]);

    const fits = layoutTextRun(run({ content: "hello", width: 60, maxLines: 1, textOverflow: "ellipsis" }));
    expect(fits.lines).toEqual(["hello"]);
  });

  it("drops nothing when no clamp is asked for", () => {
    // It wraps, and both lines are kept: the clamp is what cuts, not the wrap.
    expect(layoutTextRun(run({ content: "hello world", width: 60 })).lines).toEqual([
      "hello ",
      "world"
    ]);
  });
});

describe("where the lines sit", () => {
  it("anchors left, centre and right on the box", () => {
    expect(layoutTextRun(run()).startX).toBe(0);
    expect(layoutTextRun(run()).textAnchor).toBe("start");
    expect(layoutTextRun(run({ align: "center" })).startX).toBe(50);
    expect(layoutTextRun(run({ align: "center" })).textAnchor).toBe("middle");
    expect(layoutTextRun(run({ align: "right" })).startX).toBe(100);
    expect(layoutTextRun(run({ align: "right" })).textAnchor).toBe("end");
  });

  it("centres and bottoms the block inside the box", () => {
    // Two lines of 12px in a 40px box.
    const two = { content: "a\nb", height: 40 };
    expect(layoutTextRun(run(two)).startY).toBe(0);
    expect(layoutTextRun(run({ ...two, verticalAlign: "middle" })).startY).toBe(8);
    expect(layoutTextRun(run({ ...two, verticalAlign: "bottom" })).startY).toBe(16);
  });

  it("steps every line but the first by one line height", () => {
    const layout = layoutTextRun(run({ content: "a\nb\nc" }));
    expect(layout.placement(0).dy).toBe("0");
    expect(layout.placement(1).dy).toBe("12px");
    expect(layout.placement(2).dy).toBe("12px");
  });

  it("puts the baseline below the line box's top, by the line box's own rule", () => {
    // `startY` is the box top and SVG's `y` is the baseline, so the gap between
    // them is what an exporter has to add. No DOM here, so the analytic metrics
    // are 0.8em/0.2em: a 10px font in a 12px line leaves 1px of leading on each
    // side, and the baseline is 1 + 8 below the top.
    expect(layoutTextRun(run()).baselineOffset).toBe(9);
    // It follows the LINE HEIGHT, not the font: less leading, less offset.
    expect(layoutTextRun(run({ lineHeight: 10 })).baselineOffset).toBe(8);
    // A box that steps its lines by a line height keeps every line's baseline
    // parallel — the offset is a constant of the run, not of the line index.
    const two = layoutTextRun(run({ content: "a\nb", height: 40, verticalAlign: "bottom" }));
    expect(two.startY + two.baselineOffset).toBe(16 + 9);
  });

  it("stretches every justified line except the last", () => {
    const layout = layoutTextRun(run({ content: "a\nb\nc", align: "justify" }));
    expect(layout.placement(0)).toEqual({ x: 0, dy: "0", textLength: 100, lengthAdjust: "spacing" });
    expect(layout.placement(1).textLength).toBe(100);
    expect(layout.placement(2).textLength).toBeUndefined();
  });
});

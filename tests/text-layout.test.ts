import { describe, it, expect } from "vitest";
import { layoutTextRun, TextLayoutInput } from "../src/core/text-layout";
import { measureText, type TextMeasureSpec } from "../src/core/geometry/text-measure";

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

/** The spec `run()` lays out with, for asking `measureText` about it directly. */
const SPEC: TextMeasureSpec = {
  fontFamily: "Inter, sans-serif",
  fontSize: 10,
  fontWeight: 400,
  lineHeight: 12,
  letterSpacing: 0
};

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

  it("strips the whitespace a hard break left at the start of a line", () => {
    // `pre-line` removes leading whitespace before laying the line out, so the
    // canvas paints " thing" with no space advance. Laying the raw paragraph
    // out exported one space of ink the canvas never had, and the line sat a
    // space width right of where the editor put it.
    expect(layoutTextRun(run({ content: "a\n b" })).lines).toEqual(["a", "b"]);
    const ranged = layoutTextRun(run({ content: "aa\n bbb" }));
    expect(ranged.lines).toEqual(["aa", "bbb"]);
    expect(ranged.lineRanges).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 7 }
    ]);
    // The trimmed line is what wraps: the space does not spend box width.
    expect(layoutTextRun(run({ content: "a\n bbbb cccc", width: 42 })).lines).toEqual([
      "a",
      "bbbb ",
      "cccc"
    ]);
  });

  it("opens no line box for a trailing newline, as the browser does not", () => {
    // `white-space: pre-line` lays "a\n" out as ONE line box: the trailing
    // newline closes the line instead of opening an empty one. Counting it made
    // every such run one line taller than the canvas paints it, and a
    // middle-aligned block that overflowed its box started half a line height
    // too high — a 140px headline crossed the label above it.
    expect(layoutTextRun(run({ content: "a\n" })).lines).toEqual(["a"]);
    expect(layoutTextRun(run({ content: "a\n\n" })).lines).toEqual(["a", ""]);
    expect(layoutTextRun(run({ content: "\n" })).lines).toEqual([""]);
    // The dropped line is the split's zero-width tail: ranges stay contiguous
    // and no span can live in what was removed.
    const ranged = layoutTextRun(run({ content: "aa\n" }));
    expect(ranged.lines).toEqual(["aa"]);
    expect(ranged.lineRanges).toEqual([{ start: 0, end: 2 }]);
  });

  /**
   * The same rule, stated where it is easy to break: `layoutTextRun` drops the
   * empty paragraph a trailing newline leaves behind, and `measureText` — whose
   * analytic fallback is what runs without a DOM — has to count lines the same
   * way. It counted the empty tail, so `lines` came back one higher than the
   * layout that painted the very same string, and `maxLines` clamps against it.
   */
  it("counts lines the way the layout does, trailing newline included", () => {
    for (const content of ["a", "a\n", "a\n\n", "\n", "a\nb"]) {
      expect(measureText(content, SPEC).lines, content).toBe(layoutTextRun(run({ content })).lines.length);
    }
  });

  it("applies the same count to a span run", () => {
    const spans = (texts: string[]): TextMeasureSpec => ({
      ...SPEC,
      spans: texts.map((text) => ({ text }))
    });
    expect(measureText("a\n", spans(["a\n"])).lines).toBe(1);
    // A trailing empty span must not hide the break it follows.
    expect(measureText("a\n", spans(["a\n", ""])).lines).toBe(1);
    expect(measureText("a\n\n", spans(["a\n\n"])).lines).toBe(2);
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

  it("lets a block taller than its box spill out of both ends, as the canvas does", () => {
    // Four 12px lines in a 40px box: the canvas is a flex column, so centring an
    // overflowing block starts it ABOVE the top instead of pinning it there.
    const four = { content: "a\nb\nc\nd", height: 40 };
    expect(layoutTextRun(run({ ...four, verticalAlign: "middle" })).startY).toBe(-4);
    expect(layoutTextRun(run({ ...four, verticalAlign: "bottom" })).startY).toBe(-8);
  });

  it("moves tracked ink by the trailing-space the anchor reserves", () => {
    // `letter-spacing` is charged after the last glyph, so an anchor measured
    // against the reserved width leaves centred ink half a tracking left of
    // centre and right-aligned ink a whole one short of the edge.
    expect(layoutTextRun(run({ align: "left", letterSpacing: 4 })).startX).toBe(0);
    expect(layoutTextRun(run({ align: "center", letterSpacing: 4 })).startX).toBe(52);
    expect(layoutTextRun(run({ align: "right", letterSpacing: 4 })).startX).toBe(104);
  });

  it("steps every line but the first by one line height", () => {
    const layout = layoutTextRun(run({ content: "a\nb\nc" }));
    expect(layout.placement(0).dy).toBe("0");
    expect(layout.placement(1).dy).toBe("12px");
    expect(layout.placement(2).dy).toBe("12px");
  });

  it("reports each line's range in the source, the newlines included", () => {
    // A run is sliced onto its line by SOURCE offsets. A running total of line
    // lengths is not that total: the separator the split consumed belongs to no
    // line, and two of them shift every later run two characters left — which
    // exported an italic "thing" as upright "th" + italic "ing".
    const layout = layoutTextRun(run({ content: "aa\nbbb\ncccc" }));
    expect(layout.lines).toEqual(["aa", "bbb", "cccc"]);
    expect(layout.lineRanges).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 6 },
      { start: 7, end: 11 }
    ]);
  });

  it("keeps the ranges contiguous across a soft break", () => {
    // 6px a character: "aaaa bbbb " fits in 60 and "cccc" opens the second line.
    const layout = layoutTextRun(run({ content: "aaaa bbbb cccc", width: 60 }));
    expect(layout.lines).toEqual(["aaaa bbbb ", "cccc"]);
    expect(layout.lineRanges).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 14 }
    ]);
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

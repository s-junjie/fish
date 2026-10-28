import { describe, it, expect, afterEach } from "vitest";
import { measureText, setTextMeasurer, type TextMeasureSpec } from "../src/core/geometry/text-measure";
import { alignLineLeft, applyTextTransform, trailingTrackingShift } from "../src/core/geometry/text-measure";
import { layoutTextRun, type TextLayoutInput } from "../src/core/text-layout";
import { textSpec } from "../src/core/layout/text-sizing";
import type { TextStyle } from "../src/core/dsl/types";

/**
 * Two things the measurement used to drop on the floor, both of which are widths
 * rather than paints: the ITALIC face has its own advances, and the CASED string
 * is the one the canvas actually paints. A spec that omits either sizes the box
 * from characters nobody is looking at — and because the cache is keyed on the
 * spec, the omission made the wrong number the cached one too.
 */

const BASE: TextMeasureSpec = {
  fontFamily: "Inter",
  fontSize: 16,
  fontWeight: 400,
  lineHeight: 20,
  letterSpacing: 0
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Width proportional to the string's length, so the arithmetic in a test is checkable. */
const tally = (content: string) => ({ width: content.length, height: 1, lines: 1 });

afterEach(() => setTextMeasurer(null));

describe("measurement carries the spec's width-bearing fields", () => {
  it("keys the cache on fontStyle, so an italic run is not handed the roman number", () => {
    setTextMeasurer((content, spec) => ({
      width: content.length * (spec.fontStyle === "italic" ? 10 : 20),
      height: spec.lineHeight,
      lines: 1
    }));
    // Roman FIRST: without `fontStyle` in the key the italic read below would be
    // served this entry, and the two would be the same number.
    expect(measureText("abcd", BASE).width).toBe(80);
    expect(measureText("abcd", { ...BASE, fontStyle: "italic" }).width).toBe(40);
    // ...and the other way round, since the cache is not order-sensitive.
    expect(measureText("abcd", BASE).width).toBe(80);
  });

  it("measures the transformed string, because that is what gets painted", () => {
    setTextMeasurer((content) => ({ width: content.length, height: 1, lines: 1 }));
    // `ß` upper-cases to `SS`: the length changes, so a measurement of the raw
    // string cannot be the measurement of the paint.
    expect(measureText("ß", BASE).width).toBe(1);
    expect(measureText("ß", { ...BASE, textTransform: "uppercase" }).width).toBe(2);
    expect(measureText("ß", { ...BASE, textTransform: "none" }).width).toBe(1);
  });

  it("passes both through the real spec builder, element and run alike", () => {
    const style: TextStyle = {
      fontFamily: "Inter",
      fontSize: 16,
      color: "#000000",
      fontStyle: "italic",
      textTransform: "uppercase"
    };
    const spec = textSpec(style, [{ text: "run", style: { fontStyle: "normal" } }]);
    expect(spec.fontStyle).toBe("italic");
    expect(spec.textTransform).toBe("uppercase");
    expect(spec.spans?.[0].style?.fontStyle).toBe("normal");
    // `none` is the absence of a transform, not a transform that does nothing.
    expect(textSpec({ ...style, textTransform: "none" }, undefined).textTransform).toBeUndefined();
  });

  it("leaves the casing helper idempotent, so a transformed substring can be re-measured", () => {
    expect(applyTextTransform(applyTextTransform("hi there", "capitalize"), "capitalize")).toBe("Hi There");
    expect(applyTextTransform(applyTextTransform("hi", "uppercase"), "uppercase")).toBe("HI");
  });
});

/**
 * `capitalize`, to the letter.
 *
 * Every expectation below is Chromium's own `text-transform: capitalize` output,
 * read back through `innerText` (`text-transform` is a paint-time property, so
 * the DOM's `textContent` does not report it). The rule is not "uppercase the
 * first non-space character": that one baked `3Rd` where the browser paints
 * `3rd`, and left `well-known` and `e.g.` alone where the browser starts new
 * words. Guessing was the defect; these are the measurements.
 */
describe("capitalize matches the engine's own rule", () => {
  const cap = (s: string) => applyTextTransform(s, "capitalize");

  it("starts a new word after punctuation, not only after a space", () => {
    expect(cap("hello world")).toBe("Hello World");
    expect(cap("well-known")).toBe("Well-Known");
    expect(cap("hello.world")).toBe("Hello.World");
    expect(cap("e.g. this")).toBe("E.G. This");
    expect(cap("a/b test")).toBe("A/B Test");
    expect(cap("hello—world")).toBe("Hello—World");
    expect(cap("#tag test")).toBe("#Tag Test");
    expect(cap('"quoted speech"')).toBe('"Quoted Speech"');
  });

  it("keeps an apostrophe inside a word, and a digit in front of a letter", () => {
    // Both are the same rule from opposite sides: what continues a word is a
    // letter, a digit or an apostrophe. `3rd` keeps its `r`; `don't` keeps its `t`.
    expect(cap("3rd place")).toBe("3rd Place");
    expect(cap("x2y test")).toBe("X2y Test");
    expect(cap("100% sure")).toBe("100% Sure");
    expect(cap("don't stop")).toBe("Don't Stop");
    expect(cap("don\u2019t stop")).toBe("Don\u2019t Stop");
    expect(cap("o'brien's")).toBe("O'brien's");
  });

  it("does not apply a case mapping that changes the code-point count", () => {
    // `ﬁ` → `FI` and `ß` → `SS` are two code points; the browser leaves both, so
    // a helper that upper-cased them would bake a longer string than the canvas
    // paints and drag the measured box with it.
    expect(cap("ﬁnal count")).toBe("ﬁnal Count");
    expect(cap("ß test")).toBe("ß Test");
    // An astral letter is left alone too — measured, not assumed.
    expect(cap("\u{10428}test")).toBe("\u{10428}test");
  });

  it("upper-cases without lower-casing the rest, and survives a second pass", () => {
    expect(cap("LOWER case")).toBe("LOWER Case");
    expect(cap("élan vital")).toBe("Élan Vital");
    expect(cap("привет мир")).toBe("Привет Мир");
    expect(cap("中文 test")).toBe("中文 Test");
    expect(cap("١٢٣ abc")).toBe("١٢٣ Abc");
    expect(cap("…ellipsis test")).toBe("…Ellipsis Test");
    // Idempotent, so a run can be cased twice without drift.
    expect(cap(cap("well-known"))).toBe("Well-Known");
  });
});

/**
 * Where the painted line has to move to be aligned.
 *
 * `letter-spacing` is applied after the last character too, so the box the
 * browser reserves is one tracking wider than the ink under it. A translate is
 * the fix rather than a narrower box, because the narrower box wraps early.
 */
describe("trailing tracking", () => {
  it("shifts by nothing when there is no tracking", () => {
    expect(trailingTrackingShift("center", 0)).toBe(0);
    expect(trailingTrackingShift("right", undefined)).toBe(0);
    expect(trailingTrackingShift("left", 4)).toBe(0);
  });

  it("shifts half a tracking for centred text and a whole one for right-aligned", () => {
    expect(trailingTrackingShift("center", 4)).toBe(2);
    expect(trailingTrackingShift("right", 4)).toBe(4);
    expect(trailingTrackingShift("end", 3)).toBe(3);
    // Justified text is stretched to fill the reserved box on purpose.
    expect(trailingTrackingShift("justify", 4)).toBe(0);
  });

  /**
   * The export's half. An outlined glyph is placed by this number, so it has to
   * be the same number the canvas paints at — the box is the same, and the line
   * the browser reports is one tracking wider than its ink.
   */
  it("places an outlined line where the canvas painted it", () => {
    // A 400-wide box, tracked by 8, holding the 240-wide reserved line: the ink
    // is 232 wide and has to end up centred, i.e. starting 84 in — which is the
    // reserved box's own 80 plus half the trailing tracking.
    expect(alignLineLeft(0, 400, 240, "center", 8)).toBe(84);
    expect(alignLineLeft(0, 400, 240, "right", 8)).toBe(168);
    expect(alignLineLeft(0, 400, 240, "left", 8)).toBe(0);
    // Untracked: the reserved line IS the ink, so the plain arithmetic stands.
    expect(alignLineLeft(0, 400, 240, "center", 0)).toBe(80);
    expect(alignLineLeft(0, 400, 240, "right", 0)).toBe(160);
    // The box's own origin is carried, not assumed to be zero.
    expect(alignLineLeft(120, 400, 240, "left", 0)).toBe(120);
  });
});

describe("wrapping", () => {
  const run = (over: Partial<TextLayoutInput>): TextLayoutInput => ({
    content: "",
    x: 0,
    y: 0,
    width: 25,
    height: 200,
    fontSize: 10,
    fontFamily: "Inter",
    fontWeight: 400,
    lineHeight: 10,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    ...over
  });

  const withTally = () => setTextMeasurer((content) => ({ ...tally(content), width: content.length * 10 }));

  it("breaks between CJK characters, which need no space to break at", () => {
    withTally();
    // Two characters fit in 25px; nothing here is a space, so the old rule left
    // the paragraph on one overflowing line.
    expect(layoutTextRun(run({ content: "你好世界" })).lines).toEqual(["你好", "世界"]);
  });

  it("does not begin a line with a closing mark, nor end one with an opener", () => {
    withTally();
    // Without the rule this would be ["你好", "，世界"] — a line starting on the
    // comma that belongs to the character before it. The box is allowed to
    // overflow by the one glyph instead, which is what the browser does.
    expect(layoutTextRun(run({ content: "你好，世界" })).lines).toEqual(["你好，", "世界"]);
    // An opener that fit has to keep what follows it: without the rule this
    // would be ["你好（", "世界"], orphaning the bracket on an empty tail.
    expect(layoutTextRun(run({ content: "你好（世界", width: 35 })).lines).toEqual(["你好（世", "界"]);
  });

  it("leaves Latin breaking exactly where it was", () => {
    withTally();
    expect(layoutTextRun(run({ content: "ab cd" })).lines).toEqual(["ab", "cd"]);
    // An unbreakable word still overflows rather than being cut.
    expect(layoutTextRun(run({ content: "abcdef" })).lines).toEqual(["abcdef"]);
    // A comma leading a Latin token is the browser's own behaviour too: it
    // breaks before ",cd" and the 禁则 rule must not reach in and stop it.
    expect(layoutTextRun(run({ content: "ab ,cd" })).lines).toEqual(["ab", ",cd"]);
  });

  it("clips on a character boundary, never inside a surrogate pair", () => {
    withTally();
    // Two code units of emoji fit, the whole emoji plus the ellipsis do not. The
    // code-unit binary search took the two units — half a character — and shipped
    // the dangling high surrogate, which paints as tofu rather than as text.
    const lines = layoutTextRun(
      run({ content: "\u{1F600}x", maxLines: 1, textOverflow: "ellipsis" })
    ).lines;
    expect(lines.length).toBe(1);
    expect(LONE_SURROGATE.test(lines[0])).toBe(false);
    expect(lines[0]).toBe("\u2026");
  });

  it("reads maxLines 1 as one nowrap line, not as the first wrapped one", () => {
    withTally();
    // `white-space: nowrap` is how the canvas reaches a single-line clamp, and it
    // turns the newline into a space. Keeping the first wrapped line instead
    // would paint a run that ends where the canvas one continues.
    expect(layoutTextRun(run({ content: "ab\ncd", maxLines: 1, textOverflow: "clip" })).lines).toEqual(["ab cd"]);
    expect(
      layoutTextRun(run({ content: "ab cd ef", maxLines: 2, textOverflow: "ellipsis" })).lines.length
    ).toBe(2);
    // Nothing is cut, so nothing claims to have been: no ellipsis on text that fit.
    expect(layoutTextRun(run({ content: "ab", maxLines: 2, textOverflow: "ellipsis" })).lines).toEqual(["ab"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  auditSample,
  auditTextInk,
  authoredAlignmentOf,
  DEFAULT_TOLERANCE,
  isGroupAnchor,
  unionInkRects,
  type Rect,
  type TextInkSample
} from "../src/core/audit/text-ink";

/**
 * The rules grade the PICTURE, so the cases are pictures: a box and the ink
 * inside it. Every number here is a rectangle the engine's own tests can produce,
 * which is what keeps the audit honest — a rule that cannot be satisfied by a
 * correct document is a rule that will be ignored.
 */

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

const sample = (over: Partial<TextInkSample> = {}): TextInkSample => ({
  elementId: "home_tab0_label",
  content: "Home",
  authored: {},
  computedAlign: "left",
  box: rect(100, 40, 72, 24),
  ink: rect(100, 44, 38, 17),
  ...over
});

const rules = (s: TextInkSample, tolerance = DEFAULT_TOLERANCE) => auditSample(s, tolerance).map((f) => f.rule);

describe("what the file asked for, against what the browser computed", () => {
  it("names the authored value and the computed one", () => {
    const [finding] = auditSample(
      sample({ authored: { align: "center" }, computedAlign: "start" })
    );
    expect(finding.rule).toBe("align-not-applied");
    expect(finding.level).toBe("error");
    expect(finding.message).toBe('text-align "center" is not applied (computed: start)');
  });

  it("treats the physical and logical spellings as one statement", () => {
    // Chrome reports `start` for a left-aligned box, and the DSL stores `left`.
    // Reporting that pair would fire on every text in every document.
    expect(auditSample(sample({ authored: { align: "left" }, computedAlign: "start" }))).toEqual([]);
    expect(
      auditSample(sample({ authored: { align: "right" }, computedAlign: "end", ink: rect(134, 44, 38, 17) }))
    ).toEqual([]);
    expect(
      auditSample(sample({ authored: { align: "center" }, computedAlign: "center", ink: rect(118, 44, 36, 17) }))
    ).toEqual([]);
  });

  it("says nothing when the file states no alignment at all", () => {
    // Silence is not a claim, so a rendering that is merely unexpected is not a
    // finding — that is the whole reason intent is read from the file.
    expect(auditSample(sample({ computedAlign: "start" }))).toEqual([]);
  });

  it("reads the authored value out of every spelling an author may have written", () => {
    expect(authoredAlignmentOf({ textAlign: "center" })).toEqual({ align: "center" });
    expect(authoredAlignmentOf({ "text-align": "center" })).toEqual({ align: "center" });
    expect(authoredAlignmentOf({ align: "center" })).toEqual({ align: "center" });
    expect(authoredAlignmentOf({ style: { textAlign: "center" } })).toEqual({ align: "center" });
    expect(authoredAlignmentOf({ style: { "text-align": "center" } })).toEqual({ align: "center" });
    expect(authoredAlignmentOf({ style: { verticalAlign: "middle" } })).toEqual({ verticalAlign: "middle" });
    expect(authoredAlignmentOf({ style: "600 14 #ffffff", textAlign: "center" })).toEqual({ align: "center" });
    expect(authoredAlignmentOf(null)).toEqual({});
  });
});

describe("the reported case: a 72px tab label that rendered flush left", () => {
  const reported = sample({
    authored: { align: "center" },
    computedAlign: "center",
    // 36px of ink in a 72px box, starting at the left edge: exactly the offset
    // the feedback measured off the screenshot.
    ink: rect(100, 44, 36, 17)
  });

  it("reports the distance, in px, from the box centre", () => {
    const finding = auditSample(reported).find((f) => f.rule === "ink-not-centred");
    expect(finding?.message).toBe("ink centre is 18px left of the box centre (72px box, 36px of ink)");
  });

  it("stays quiet once the ink is centred", () => {
    expect(rules({ ...reported, ink: rect(118, 44, 36, 17) })).toEqual([]);
  });

  it("accepts a sub-pixel miss, because that is what kerning produces", () => {
    expect(rules({ ...reported, ink: rect(118.6, 44, 36, 17) })).toEqual([]);
  });
});

describe("right alignment is measured against the right edge", () => {
  const rightAligned = sample({ authored: { align: "right" }, computedAlign: "right", ink: rect(112, 44, 38, 17) });

  it("reports ink that stops short of the edge", () => {
    const finding = auditSample(rightAligned).find((f) => f.rule === "ink-not-right");
    expect(finding?.message).toBe("ink right edge is 22px inside the box right edge (72px box)");
  });

  it("says nothing when the ink ends on it", () => {
    expect(rules({ ...rightAligned, ink: rect(134, 44, 38, 17) })).toEqual([]);
  });
});

describe("a label and the icon beside it share a centre", () => {
  const withIcon = (deltaY: number) =>
    sample({
      computedAlign: "left",
      // Icon centre y = 52, which is the box centre at deltaY = 0.
      group: { elementId: "home_tab0_icon", box: rect(76, 44, 16, 16) },
      box: rect(100, 40 + deltaY, 72, 24),
      ink: rect(100, 44 + deltaY, 38, 17)
    });

  it("reports a label whose box sits below its icon", () => {
    const [finding] = auditSample(withIcon(6));
    expect(finding.rule).toBe("group-not-centred");
    expect(finding.level).toBe("warning");
    expect(finding.message).toContain('the centre of "home_tab0_icon"');
  });

  it("compares boxes, not glyphs", () => {
    // A line box carries descender space the glyphs do not fill, so grading the
    // INK against an icon reports a correct row: 14px of ink inside a 24px box
    // sits ~2.8px above the box centre, and that is not a defect.
    const aligned = withIcon(0);
    expect(auditSample({ ...aligned, ink: rect(100, 41, 38, 17) }).map((f) => f.rule)).toEqual([]);
  });

  it("falls back to the row only when the row states a centre", () => {
    const centredRow = { box: rect(40, 36, 160, 32), alignItems: "center" };
    expect(rules(sample({ parent: centredRow, box: rect(100, 50, 72, 24) }))).toEqual(["group-not-centred"]);
    expect(rules(sample({ parent: { ...centredRow, alignItems: "flex-start" }, box: rect(100, 50, 72, 24) }))).toEqual(
      []
    );
    expect(rules(sample({ parent: centredRow, box: rect(100, 40, 72, 24) }))).toEqual([]);
  });
});

/**
 * Which sibling is the PAIR.
 *
 * The group rule compares centres, so the question it has to answer first is
 * whether two boxes were ever aimed at each other. Taken as "the nearest sibling
 * by centre y", every text on a free canvas had a pair, and a poster came back
 * with nineteen findings of the shape "kicker is 2px below paper_grain".
 */
describe("what counts as the neighbour a text lines up with", () => {
  const parent = rect(40, 36, 160, 32);
  const label = rect(100, 40, 72, 24);

  it("is the icon beside it", () => {
    expect(isGroupAnchor(label, rect(76, 44, 16, 16), parent)).toBe(true);
  });

  it("is not a full-bleed layer — a texture is the surface, not a partner", () => {
    const poster = rect(0, 0, 800, 1000);
    expect(isGroupAnchor(rect(40, 80, 200, 20), rect(0, 0, 800, 1000), poster)).toBe(false);
  });

  it("is not something in another column", () => {
    const poster = rect(0, 0, 800, 600);
    expect(isGroupAnchor(rect(40, 80, 200, 20), rect(600, 90, 150, 20), poster)).toBe(false);
  });

  it("is not the sibling it is stacked under — a column has no shared centre", () => {
    const poster = rect(0, 0, 800, 600);
    expect(isGroupAnchor(rect(40, 80, 200, 20), rect(40, 120, 200, 20), poster)).toBe(false);
  });

  it("is not a display glyph twenty times its size", () => {
    const poster = rect(0, 0, 800, 600);
    expect(isGroupAnchor(rect(40, 80, 200, 20), rect(40, 0, 300, 400), poster)).toBe(false);
  });
});

describe("a box that paints nothing", () => {
  it("is an error when it holds text", () => {
    const [finding] = auditSample(sample({ ink: null }));
    expect(finding.rule).toBe("no-ink");
    expect(finding.level).toBe("error");
  });

  it("is not a finding when it holds no text", () => {
    expect(auditSample(sample({ ink: null, content: "   " }))).toEqual([]);
  });
});

describe("the ink box a browser's fragments add up to", () => {
  it("drops the tracking the line reserves past the last glyph", () => {
    // A 100-wide inline box carrying 4px of tracking over 90px of glyphs: the
    // browser reports the reserved advance, the eye does not see it.
    expect(unionInkRects([rect(0, 0, 100, 20)], 4)).toEqual(rect(0, 0, 96, 20));
  });

  it("applies it per line, not once to the widest", () => {
    const two = unionInkRects([rect(0, 0, 100, 20), rect(0, 22, 60, 20)], 4);
    expect(two).toEqual({ x: 0, y: 0, width: 96, height: 42 });
  });

  it("extends the right edge for negative tracking, because the ink overhangs the box", () => {
    // -8px tracking makes the reserved inline box NARROWER than the glyphs by
    // 8px; the renderer shifts the line back by the same amount. The correction
    // must therefore add |tracking| on this side, not subtract it.
    expect(unionInkRects([rect(0, 0, 92, 20)], -8)).toEqual(rect(0, 0, 100, 20));
  });

  it("unions the fragments of one line and keeps both lines", () => {
    const ink = unionInkRects([rect(0, 0, 40, 20), rect(44, 0, 40, 20), rect(0, 22, 84, 20)], 0);
    expect(ink).toEqual({ x: 0, y: 0, width: 84, height: 42 });
  });

  it("returns nothing when no fragment has area", () => {
    expect(unionInkRects([], 0)).toBeNull();
    expect(unionInkRects([rect(0, 0, 0, 20)], 0)).toBeNull();
  });
});

describe("the rule set is a list, not a habit", () => {
  it("audits every sample and keeps the element ids", () => {
    const findings = auditTextInk([
      sample({ elementId: "a", authored: { align: "center" }, computedAlign: "start" }),
      sample({ elementId: "b", authored: { align: "center" }, computedAlign: "center", ink: rect(100, 44, 36, 17) })
    ]);
    expect(findings.map((f) => `${f.elementId}:${f.rule}`)).toEqual([
      "a:align-not-applied",
      "b:ink-not-centred"
    ]);
  });

  it("scales with the tolerance it is given", () => {
    const loose = { x: 20, y: 20 };
    expect(rules(sample({ computedAlign: "center" }), loose)).toEqual([]);
  });
});

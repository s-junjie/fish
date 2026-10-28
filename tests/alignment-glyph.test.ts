// The drawing beside an alignment option is the option's definition, so it is
// graded against the same arithmetic the layout pass uses — not against a
// snapshot of the shapes it happens to emit today.
//
// Two things it can get wrong that a snapshot would happily preserve:
//
//   - the six Distributions collapse into fewer than six pictures (that is what
//     makes the menu useless), and
//   - a later option — or a fourth item — shrinks a block below the size at
//     which the drawing still reads at 22px in the field.

import { describe, expect, it } from "vitest";
import {
  AlignmentKind,
  AlignmentValue,
  GLYPH_H,
  GLYPH_W,
  alignmentGlyphGeometry
} from "../src/ui/inspector/AlignmentGlyph";

const KINDS: Record<AlignmentKind, AlignmentValue[]> = {
  justify: ["start", "center", "end", "space-between", "space-around", "space-evenly"],
  align: ["start", "center", "end", "stretch"],
  "align-content": ["start", "center", "end", "space-between", "space-around", "space-evenly"],
  "align-self": ["auto", "start", "center", "end", "stretch"]
};

const geo = (kind: AlignmentKind, value: AlignmentValue) => alignmentGlyphGeometry(kind, value);
const xs = (kind: AlignmentKind, value: AlignmentValue) => geo(kind, value).shapes.map((s) => s.x);
const lead = (kind: AlignmentKind, value: AlignmentValue) => Math.min(...xs(kind, value));

describe("alignment glyphs", () => {
  it("draws nothing outside the box it is scaled into", () => {
    for (const kind of Object.keys(KINDS) as AlignmentKind[]) {
      for (const value of KINDS[kind]) {
        const { shapes } = geo(kind, value);
        expect(shapes.length, `${kind}/${value}`).toBeGreaterThan(0);
        for (const s of shapes) {
          expect(s.x, `${kind}/${value} x`).toBeGreaterThanOrEqual(0);
          expect(s.y, `${kind}/${value} y`).toBeGreaterThanOrEqual(0);
          expect(s.x + s.w, `${kind}/${value} right`).toBeLessThanOrEqual(GLYPH_W);
          expect(s.y + s.h, `${kind}/${value} bottom`).toBeLessThanOrEqual(GLYPH_H);
        }
      }
    }
  });

  it("keeps every block large enough to survive the field's 22px", () => {
    for (const kind of Object.keys(KINDS) as AlignmentKind[]) {
      for (const value of KINDS[kind]) {
        for (const s of geo(kind, value).shapes) {
          expect(s.w, `${kind}/${value}: w`).toBeGreaterThan(2);
          expect(s.h, `${kind}/${value}: h`).toBeGreaterThan(1.5);
        }
      }
    }
  });

  it("draws the six distributions as four different pictures", () => {
    // Five values must separate on the leading gap alone; `center` is the one
    // that differs by symmetry instead (it is between `start` and `end`).
    const pad = lead("justify", "start");
    const between = lead("justify", "space-between");
    const around = lead("justify", "space-around");
    const evenly = lead("justify", "space-evenly");
    expect(between).toBeCloseTo(pad, 5);
    expect(around).toBeGreaterThan(between);
    expect(evenly).toBeGreaterThan(around);

    const start = xs("justify", "start");
    const middle = xs("justify", "center");
    const end = xs("justify", "end");
    expect(middle).not.toEqual(start);
    expect(end).not.toEqual(middle);
  });

  it("anchors the main-axis items where the value says", () => {
    const pad = lead("justify", "start");
    const { shapes } = geo("justify", "end");
    const last = shapes[shapes.length - 1];
    expect(last.x + last.w).toBeCloseTo(GLYPH_W - pad, 5);

    // `center` is symmetric about the box's own centre.
    const centred = geo("justify", "center").shapes;
    const first = centred[0];
    const tail = GLYPH_W - (centred[centred.length - 1].x + centred[centred.length - 1].w);
    expect(tail).toBeCloseTo(first.x, 5);
  });

  it("stretch fills the cross axis and nothing else does", () => {
    const stretched = geo("align", "stretch").shapes;
    for (const s of stretched) expect(s.h).toBeCloseTo(GLYPH_H - 2 * stretched[0].y, 5);

    for (const value of ["start", "center", "end"] as AlignmentValue[]) {
      const shapes = geo("align", value).shapes;
      expect(Math.max(...shapes.map((s) => s.h))).toBeLessThan(stretched[0].h);
    }
  });

  it("puts every item on one shared midline for Align · Center", () => {
    const shapes = geo("align", "center").shapes;
    const centres = shapes.map((s) => s.y + s.h / 2);
    for (const c of centres) expect(c).toBeCloseTo(centres[0], 5);
    expect(geo("align", "center").guide?.y).toBeCloseTo(centres[0], 5);
  });

  it("says WHICH item align-self moves, not only where it went", () => {
    for (const value of ["start", "center", "end", "stretch", "auto"] as AlignmentValue[]) {
      const shapes = geo("align-self", value).shapes;
      const hi = shapes.filter((s) => s.tone === "hi");
      expect(hi.length, `${value}: exactly one item is the subject`).toBe(1);
      expect(shapes.filter((s) => s.tone === "faint").length).toBe(shapes.length - 1);
      // The subject is the middle one, and `auto` is the only dashed shape in
      // the whole set — its ink means "inherited", and nothing else may use it.
      expect(shapes.indexOf(hi[0])).toBe(1);
      if (value === "auto") {
        expect(hi[0].dashed).toBe(true);
        // An inherited value is drawn where the container's `start` would put it.
        expect(hi[0].y).toBeCloseTo(geo("align-self", "start").shapes[1].y, 5);
      } else {
        expect(hi[0].dashed, `${value}: a declared value is not dashed`).toBeFalsy();
      }
    }
  });

  it("treats align-content as LINES, two of them", () => {
    for (const value of KINDS["align-content"]) {
      const shapes = geo("align-content", value).shapes;
      expect(shapes.length, `${value}: three items over two lines`).toBe(5);
      const rows = [...new Set(shapes.map((s) => s.y))];
      expect(rows.length, `${value}: two distinct rows`).toBe(2);
    }

    // The first and last line sit on the box edges for space-between, which is
    // what makes it look different from space-around at 46px.
    const top = Math.min(...geo("align-content", "start").shapes.map((s) => s.y));
    const between = geo("align-content", "space-between").shapes;
    const bottom = Math.max(...between.map((s) => s.y + s.h));
    expect(Math.min(...between.map((s) => s.y))).toBeCloseTo(top, 5);
    expect(bottom).toBeCloseTo(GLYPH_H - top, 5);

    const evenly = Math.min(...geo("align-content", "space-evenly").shapes.map((s) => s.y));
    const around = Math.min(...geo("align-content", "space-around").shapes.map((s) => s.y));
    expect(evenly).toBeGreaterThan(top);
    expect(around).toBeLessThan(evenly);
  });
});

import { describe, it, expect } from "vitest";
import { renderNonUniformStroke, SideStrokeBox } from "../src/ui/canvas/non-uniform-stroke";
import { ResolvedStrokeWeights, resolveStrokeWeights, strokeDashAttrs } from "../src/core/geometry/stroke-utils";
import { Stroke } from "../src/core/dsl/types";

function piecesOf(node: any): any[] {
  return [].concat(node.props.children);
}

function byKey(node: any): Record<string, any> {
  return Object.fromEntries(piecesOf(node).map((p) => [p.key, p.props]));
}

function render(
  stroke: Stroke,
  align: "inside" | "center" | "outside" = "center",
  box: Partial<SideStrokeBox> = {}
): any {
  const weights = resolveStrokeWeights(stroke);
  expect(weights.isUniform).toBe(false);
  return paint(weights, align, box, stroke);
}

/**
 * Straight to the geometry, past `resolveStrokeWeights`.
 *
 * Four EQUAL custom weights resolve as uniform and never reach this function —
 * they go down `shapeLocalD`, which rounds on its own. So the equal-sided case
 * below is reachable in practice only through a near-uniform one (a 4/4/4/6
 * border), and asking for the geometry directly is the honest way to pin it.
 */
function paint(
  weights: ResolvedStrokeWeights,
  align: "inside" | "center" | "outside" = "center",
  box: Partial<SideStrokeBox> = {},
  stroke: Stroke = { width: 4 }
): any {
  return renderNonUniformStroke(
    { ...weights, isUniform: false },
    { width: 100, height: 50, ...box },
    "#FF0000",
    align,
    strokeDashAttrs(stroke),
    1,
    "clip_x",
    "mask_x",
    "k"
  );
}

const ALL_SIDES: ResolvedStrokeWeights = { top: 4, right: 4, bottom: 4, left: 4, isUniform: true };

describe("renderNonUniformStroke", () => {
  it("draws nothing when every side is zero", () => {
    const node = renderNonUniformStroke({ top: 0, right: 0, bottom: 0, left: 0, isUniform: false }, { width: 100, height: 50 }, "#FF0000", "center", {}, 1);
    expect(node).toBeNull();
  });

  it("a single-sided stroke emits one line on that side", () => {
    const node = render({ width: 8, color: "#FF0000", side: "top" });
    const lines = piecesOf(node);
    expect(lines).toHaveLength(1);
    expect(lines[0].props).toMatchObject({
      x1: 0,
      x2: 100,
      stroke: "#FF0000",
      strokeWidth: 8
    });
  });

  it("custom sides emit one line per non-zero side", () => {
    const node = render({ width: 0, color: "#FF0000", side: "custom", sides: { top: 2, right: 6, bottom: 0, left: 10 } });
    const lines = piecesOf(node).filter((p) => p.type === "line");
    expect(Object.fromEntries(lines.map((l) => [l.key, l.props.strokeWidth]))).toEqual({ t: 2, r: 6, l: 10 });
  });

  it("align moves the line, it does not change its width", () => {
    const inside = piecesOf(render({ width: 8, side: "top" }, "inside"))[0].props;
    const center = piecesOf(render({ width: 8, side: "top" }, "center"))[0].props;
    const outside = piecesOf(render({ width: 8, side: "top" }, "outside"))[0].props;
    expect([inside.y1, center.y1, outside.y1]).toEqual([4, 0, -4]);
    expect([inside.strokeWidth, center.strokeWidth, outside.strokeWidth]).toEqual([8, 8, 8]);
  });

  it("moves the BOTTOM line the other way, or outside draws inside the shape", () => {
    const inside = piecesOf(render({ width: 8, side: "bottom" }, "inside"))[0].props;
    const center = piecesOf(render({ width: 8, side: "bottom" }, "center"))[0].props;
    const outside = piecesOf(render({ width: 8, side: "bottom" }, "outside"))[0].props;
    // Box is 100x50: the bottom edge is y=50, and the band centre must sit on
    // the side the align asks for — inside above it, outside below it.
    expect([inside.y1, center.y1, outside.y1]).toEqual([46, 50, 54]);
  });

  it("clips inside and masks outside, leaving center bare", () => {
    expect(render({ width: 8, side: "top" }, "inside").props.clipPath).toBe("url(#clip_x)");
    expect(render({ width: 8, side: "top" }, "outside").props.mask).toBe("url(#mask_x)");
    const center = render({ width: 8, side: "top" }, "center");
    expect(center.props.clipPath).toBeUndefined();
    expect(center.props.mask).toBeUndefined();
  });

  it("threads dash and opacity through", () => {
    const weights = resolveStrokeWeights({ width: 8, side: "top" });
    const node: any = renderNonUniformStroke(
      weights,
      { width: 100, height: 50 },
      "#FF0000",
      "center",
      strokeDashAttrs({ width: 8, dashArray: [6, 4] }),
      0.5,
      "clip_x",
      "mask_x",
      "k"
    );
    expect(node.props.opacity).toBe(0.5);
    expect(piecesOf(node)[0].props.strokeDasharray).toBe("6 4");
  });

  it("carries the cap onto each edge instead of forcing butt", () => {
    const node: any = render({ width: 8, side: "top", cap: "round" });
    expect(piecesOf(node)[0].props.strokeLinecap).toBe("round");
  });
});

describe("renderNonUniformStroke corners", () => {
  it("rounds the corners when the box has a radius", () => {
    const node = paint(ALL_SIDES, "center", { radii: [8, 8, 8, 8] });
    const pieces = byKey(node);
    // Four edges plus four arcs — the whole point: the border now goes round.
    expect(Object.keys(pieces).sort()).toEqual(["b", "c_bl", "c_br", "c_tl", "c_tr", "l", "r", "t"]);
    expect(pieces.c_tl.d).toBe("M 8 0 A 8 8 0 0 0 0 8");
    expect(pieces.c_tr.d).toBe("M 92 0 A 8 8 0 0 1 100 8");
    expect(pieces.c_br.d).toBe("M 100 42 A 8 8 0 0 1 92 50");
    // BL runs left-point to bottom-point, which is the one direction whose
    // short way round the corner is counter-clockwise: sweep 0, not 1.
    expect(pieces.c_bl.d).toBe("M 0 42 A 8 8 0 0 0 8 50");
  });

  it("stops each edge at its arc so the two meet instead of overlapping", () => {
    const pieces = byKey(paint(ALL_SIDES, "center", { radii: [8, 8, 8, 8] }));
    expect([pieces.t.x1, pieces.t.x2]).toEqual([8, 92]);
    expect([pieces.b.x1, pieces.b.x2]).toEqual([8, 92]);
    expect([pieces.l.y1, pieces.l.y2]).toEqual([8, 42]);
    expect([pieces.r.y1, pieces.r.y2]).toEqual([8, 42]);
  });

  it("keeps the arc on the shape's centre and moves only its radius, so align still works", () => {
    const centre = byKey(paint(ALL_SIDES, "center", { radii: [8, 8, 8, 8] })).c_tl.d;
    const inside = byKey(paint(ALL_SIDES, "inside", { radii: [8, 8, 8, 8] })).c_tl.d;
    const outside = byKey(paint(ALL_SIDES, "outside", { radii: [8, 8, 8, 8] })).c_tl.d;
    // 4px stroke: inside pulls the arc in by 2, outside pushes it out by 2.
    expect(centre).toBe("M 8 0 A 8 8 0 0 0 0 8");
    expect(inside).toBe("M 8 2 A 6 6 0 0 0 2 8");
    expect(outside).toBe("M 8 -2 A 10 10 0 0 0 -2 8");
  });

  it("runs a single-sided border square to the corner, the way CSS and Figma both do", () => {
    const node = render({ width: 8, side: "top" }, "center", { radii: [8, 8, 8, 8] });
    const pieces = byKey(node);
    expect(Object.keys(pieces)).toEqual(["t"]);
    expect([pieces.t.x1, pieces.t.x2]).toEqual([0, 100]);
  });

  it("rounds only the corners where both sides are stroked", () => {
    const pieces = byKey(paint({ top: 4, right: 0, bottom: 0, left: 4, isUniform: false }, "center", { radii: [8, 8, 8, 8] }));
    expect(Object.keys(pieces).sort()).toEqual(["c_tl", "l", "t"]);
    // The top edge stops at the arc on one end and runs square on the other.
    expect([pieces.t.x1, pieces.t.x2]).toEqual([8, 100]);
    expect([pieces.l.y1, pieces.l.y2]).toEqual([8, 50]);
  });

  it("takes the wider of two mismatched weights for the arc between them", () => {
    const pieces = byKey(paint({ top: 4, right: 4, bottom: 4, left: 10, isUniform: false }, "center", { radii: [8, 8, 8, 8] }));
    expect(pieces.c_tl.strokeWidth).toBe(10);
    expect(pieces.c_tr.strokeWidth).toBe(4);
  });

  it("rides the wider side's offset on BOTH arc endpoints, not just the radius", () => {
    // Outside align, left=10 against top=4: the TL corner must be a true
    // circle on (8,8) at the 10-wide offset (radius 13), with the endpoint on
    // the TOP side pulled out to that same offset. Leaving an endpoint on the
    // narrower side's offset puts it at a different distance from the centre
    // than the radius claims, and SVG re-solves the circle through both
    // points — an arc centred off the corner that the outside mask chops into
    // a wedge notch.
    const pieces = byKey(paint({ top: 4, right: 4, bottom: 4, left: 10, isUniform: false }, "outside", { radii: [8, 8, 8, 8] }));
    expect(pieces.c_tl.d).toBe("M 8 -5 A 13 13 0 0 0 -5 8");
    expect(pieces.c_tr.d).toBe("M 92 -2 A 10 10 0 0 1 102 8");
    expect(pieces.c_br.d).toBe("M 102 42 A 10 10 0 0 1 92 52");
    expect(pieces.c_bl.d).toBe("M -5 42 A 13 13 0 0 0 8 55");
    expect([pieces.c_tl.strokeWidth, pieces.c_tr.strokeWidth, pieces.c_br.strokeWidth, pieces.c_bl.strokeWidth]).toEqual([10, 4, 4, 10]);
  });

  it("keeps every corner arc a true circle on the shape's own corner centre", () => {
    // The invariant behind the pinned strings above: parse each arc and check
    // both endpoints sit exactly on the circle the radius claims, centred
    // where the shape's own corner arc is centred. Any future radius or
    // endpoint change that breaks this re-opens the wedge-notch class of bug.
    const centres = { c_tl: [8, 8], c_tr: [92, 8], c_br: [92, 42], c_bl: [8, 42] } as const;
    const parse = (d: string) => {
      const m = /^M ([\d.-]+) ([\d.-]+) A ([\d.-]+) [\d.-]+ 0 0 [01] ([\d.-]+) ([\d.-]+)$/.exec(d);
      expect(m, d).not.toBeNull();
      const [x1, y1, r, x2, y2] = m!.slice(1).map(Number);
      return { x1, y1, r, x2, y2 };
    };
    for (const align of ["inside", "center", "outside"] as const) {
      for (const sides of [
        { top: 4, right: 4, bottom: 4, left: 10 },
        { top: 50, right: 24, bottom: 13, left: 13 },
        { top: 2, right: 30, bottom: 7, left: 19 }
      ]) {
        const pieces = byKey(paint({ ...sides, isUniform: false }, align, { radii: [8, 8, 8, 8] }));
        for (const [key, [cx, cy]] of Object.entries(centres)) {
          const a = parse(pieces[key].d);
          // A radius that clamps to zero (inside align, weight over twice the
          // corner radius) degenerates to the straight diagonal between the
          // endpoints — a miter, the honest fallback when no arc fits.
          if (a.r === 0) continue;
          const d1 = Math.hypot(a.x1 - cx, a.y1 - cy);
          const d2 = Math.hypot(a.x2 - cx, a.y2 - cy);
          expect(d1, `${key} ${align} from`).toBeCloseTo(a.r, 6);
          expect(d2, `${key} ${align} to`).toBeCloseTo(a.r, 6);
        }
      }
    }
  });

  it("clamps a radius larger than the box, the way the shape's own path does", () => {
    // A 50px box cannot carry a 999px radius; both sides must agree on 25.
    const pieces = byKey(paint(ALL_SIDES, "center", { width: 50, height: 50, radii: [999, 999, 999, 999] }));
    expect(pieces.c_tl.d).toBe("M 25 0 A 25 25 0 0 0 0 25");
  });

  it("draws nothing extra for a square-cornered box", () => {
    const pieces = byKey(paint(ALL_SIDES, "center"));
    expect(Object.keys(pieces).sort()).toEqual(["b", "l", "r", "t"]);
  });
});
import { describe, expect, it } from "vitest";
import { tornEdgeGeometry, TORN_EDGE_DEFAULT } from "../src/core/geometry/torn-edge";
import { edgeFor } from "../src/core/geometry/edge";
import { normalizeEffects } from "../src/core/dsl/normalize/effects";
import type { TornEdge } from "../src/core/dsl/types";

const box = { w: 320, h: 460 };
const base = (over: Partial<TornEdge> = {}): TornEdge => ({
  ...TORN_EDGE_DEFAULT,
  seed: 7,
  ...over
});

/** Every number a `d` mentions, in order. */
function numbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

describe("torn edge geometry", () => {
  it("is the same tear for the same seed — determinism is what makes an export a picture of the canvas", () => {
    const a = tornEdgeGeometry(box.w, box.h, base());
    const b = tornEdgeGeometry(box.w, box.h, base());
    expect(a.region).toBe(b.region);
    expect(a.fringe).toBe(b.fringe);
    expect(a.ply).toBe(b.ply);
    expect(a.veil).toBe(b.veil);
  });

  it("is a different tear for a different seed", () => {
    const a = tornEdgeGeometry(box.w, box.h, base({ seed: 7 }));
    const b = tornEdgeGeometry(box.w, box.h, base({ seed: 8 }));
    expect(a.curve).not.toBe(b.curve);
  });

  it("never folds back on itself: one x per y, strictly increasing", () => {
    for (const side of ["left", "right"] as const) {
      const { points } = tornEdgeGeometry(box.w, box.h, base({ side }));
      for (let i = 1; i < points.length; i++) {
        // A self-intersecting silhouette punches a hole under evenodd and the
        // paper comes out in pieces; monotonic y is the invariant that prevents it.
        expect(points[i].y).toBeGreaterThan(points[i - 1].y);
      }
    }
  });

  it("bites inward by up to twice the amplitude, and never outward", () => {
    // `scale` buys the peak excursion; an edge break spends it all INSIDE the
    // box, so the depth runs 0..2·amp and the silhouette never leaves the layer.
    const edge = base({ side: "right", scale: 150, roughness: 1 });
    const { points } = tornEdgeGeometry(box.w, box.h, edge);
    const amp = 150 * (0.085 + 0.045 + 0.013);
    for (const p of points) {
      const depth = box.w - p.x;
      expect(depth).toBeGreaterThanOrEqual(-0.02);
      expect(depth).toBeLessThanOrEqual(2 * amp + 0.02);
    }
  });

  it("anchors the region on the two corners the break does not touch", () => {
    const right = tornEdgeGeometry(box.w, box.h, base({ side: "right" }), 40, 90);
    const n = numbers(right.region);
    // Starts at the far top corner, ends the straight edge at the far bottom one.
    expect(n.slice(0, 2)).toEqual([40, 90]);
    expect(right.region.trimEnd().endsWith("Z")).toBe(true);
  });

  it("emits a closed region for every side", () => {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const g = tornEdgeGeometry(box.w, box.h, base({ side }));
      expect(g.region.startsWith("M ")).toBe(true);
      expect(g.region.endsWith("Z")).toBe(true);
      // Four path commands' worth of structure at minimum: the two corner lines
      // plus the curve between them.
      expect(numbers(g.region).length).toBeGreaterThan(12);
    }
  });

  it("closes all three paper ply bands, and leaves them empty when there are no fibres", () => {
    const withFibre = tornEdgeGeometry(box.w, box.h, base({ fiber: 0.8 }));
    expect(withFibre.fringe.endsWith("Z")).toBe(true);
    expect(withFibre.ply.endsWith("Z")).toBe(true);
    expect(withFibre.veil.endsWith("Z")).toBe(true);
    expect(withFibre.fringe.length).toBeGreaterThan(withFibre.curve.length);
    expect(withFibre.ply.length).toBeGreaterThan(withFibre.curve.length);
    expect(withFibre.veil.length).toBeGreaterThan(withFibre.curve.length);
    expect(withFibre.fringe).not.toBe(withFibre.ply);
    expect(withFibre.ply).not.toBe(withFibre.veil);

    const none = tornEdgeGeometry(box.w, box.h, base({ fiber: 0 }));
    // Zero fibres is a clean break: same curve, and no band to paint at all.
    expect(none.fringe).toBe("");
    expect(none.ply).toBe("");
    expect(none.veil).toBe("");
    expect(none.points.length).toBe(withFibre.points.length);
  });

  it("moves the whole break with the box origin, not just the corners", () => {
    const a = tornEdgeGeometry(box.w, box.h, base(), 0, 0);
    const b = tornEdgeGeometry(box.w, box.h, base(), 120, 300);
    const pa = numbers(a.region);
    const pb = numbers(b.region);
    for (let i = 0; i < 6; i += 2) {
      expect(pb[i] - pa[i]).toBeCloseTo(120, 1);
      expect(pb[i + 1] - pa[i + 1]).toBeCloseTo(300, 1);
    }
  });
});

const SIDES = ["top", "right", "bottom", "left"] as const;

describe("the break stays inside the box", () => {
  it("never paints outside the box on any side, at any size", () => {
    // The box is the contract: alignment, snapping, constraints and the export
    // bounds all describe it. A silhouette that leaves it is a shape the
    // document cannot see, so every coordinate the region mentions is graded.
    for (const side of SIDES) {
      for (const scale of [40, 150, 500]) {
        const edge = base({ side, scale, roughness: 0.8 });
        const origin = { x: 40, y: 90 };
        const g = tornEdgeGeometry(box.w, box.h, edge, origin.x, origin.y);
        const n = numbers(g.region);
        for (let i = 0; i < n.length; i += 2) {
          expect(n[i], `${side}@${scale} x`).toBeGreaterThanOrEqual(origin.x - 0.02);
          expect(n[i], `${side}@${scale} x`).toBeLessThanOrEqual(origin.x + box.w + 0.02);
          expect(n[i + 1], `${side}@${scale} y`).toBeGreaterThanOrEqual(origin.y - 0.02);
          expect(n[i + 1], `${side}@${scale} y`).toBeLessThanOrEqual(origin.y + box.h + 0.02);
        }
      }
    }
  });

  it("keeps the fibres inside too — paper outside the layer's box is not paper", () => {
    const g = tornEdgeGeometry(box.w, box.h, base({ side: "right", scale: 150, fiber: 1 }));
    for (const d of [g.fringe, g.ply, g.veil]) {
      const n = numbers(d);
      for (let i = 0; i < n.length; i += 2) {
        expect(n[i]).toBeGreaterThanOrEqual(-0.02);
        expect(n[i]).toBeLessThanOrEqual(box.w + 0.02);
      }
    }
  });

  it("shares one curve between the two halves of a split, so the seam closes", () => {
    const cut = { at: 0.5, seed: 9, scale: 150, roughness: 0.6, fiber: 0.5 };
    const left = tornEdgeGeometry(box.w, box.h, base({ side: "right", ...cut }));
    const right = tornEdgeGeometry(box.w, box.h, base({ side: "left", ...cut }));
    expect(left.curve).toBe(right.curve);
  });

  it("moves the guide with `at` instead of pinning it to the edge", () => {
    const at = (v: number) => tornEdgeGeometry(box.w, box.h, base({ side: "right", at: v }));
    const mean = (d: string) => {
      const n = numbers(d);
      const xs: number[] = [];
      for (let i = 0; i < n.length; i += 2) xs.push(n[i]);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(mean(at(1).curve)).toBeGreaterThan(mean(at(0.5).curve));
    expect(mean(at(0.5).curve)).toBeGreaterThan(mean(at(0).curve));
  });
});

describe("closed break", () => {
  let slot = 0;
  const hole = (over: Record<string, unknown> = {}) =>
    edgeFor(
      `hole_${slot++}`,
      0,
      10,
      20,
      320,
      460,
      { profile: "torn", scale: 120, roughness: 0.6, fiber: 0, seed: 7, form: "hole", ...over } as any
    );

  it("knocks the loop out of the sheet — or keeps only the piece — and closes it", () => {
    expect((hole().region.match(/M /g) || []).length).toBe(2);
    expect((hole({ form: "scrap" }).region.match(/M /g) || []).length).toBe(1);

    // The field is written over a straight run and does not return to its
    // starting value after a lap; the mirror is what closes it, so a gap larger
    // than one sample step would mean the seam is open.
    const p = hole().points;
    const step = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
    const seam = Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y);
    expect(seam).toBeLessThan(step * 1.6);
  });

  it("stays inside the box it declares, whatever the inset says", () => {
    for (const inset of [0, 40, 100]) {
      const g = hole({ inset });
      for (const q of g.points) {
        expect(q.x).toBeGreaterThanOrEqual(10);
        expect(q.x).toBeLessThanOrEqual(330);
        expect(q.y).toBeGreaterThanOrEqual(20);
        expect(q.y).toBeLessThanOrEqual(480);
      }
    }
  });
});

describe("tilted break", () => {
  const at = (a: number | [number, number]) =>
    edgeFor("tilt", 0, 0, 0, 200, 300, {
      side: "right",
      profile: "torn",
      scale: 60,
      roughness: 0.6,
      fiber: 0,
      seed: 3,
      at: a
    });
  const xOf = (g: { points: { x: number }[] }, i: number) => g.points[i === 0 ? 0 : g.points.length - 1].x;

  it("gives the two ends their own position across the box", () => {
    const flat = at(1);
    expect(Math.abs(xOf(flat, 0) - xOf(flat, 1))).toBeLessThan(2);

    // Top end stays on the edge, bottom end pulled halfway across.
    const tilted = at([1, 0.5]);
    expect(xOf(tilted, 0) - xOf(tilted, 1)).toBeGreaterThan(80);
    // The break still spans the side: the region starts on the top edge.
    expect(tilted.region.startsWith("M 0.00 0.00 L 1")).toBe(true);
  });
});

describe("torn edge normalization", () => {
  const effects = (raw: unknown[]) => normalizeEffects(raw);

  it("keeps a declared break and clamps the sliders into range", () => {
    const [ef] = effects([{ type: "torn-edge", side: "bottom", scale: 9999, roughness: 4, fiber: -2, seed: 3.7 }]);
    expect(ef).toMatchObject({ type: "tear", profile: "torn", side: "bottom", scale: 900, roughness: 1, fiber: 0, seed: 4 });
    expect(ef.enabled).toBe(true);
  });

  it("refuses a side it does not know rather than guessing one", () => {
    expect(effects([{ type: "torn-edge", side: "diagonal" }])).toEqual([]);
    expect(effects([{ type: "torn-edge" }])).toEqual([]);
    expect(effects([{ type: "torn-edge", side: "right" }]).length).toBe(1);
  });

  it("defaults the rest of a break declared only by side", () => {
    const [ef] = effects([{ type: "torn-edge", side: "left" }]);
    expect(ef).toMatchObject({ side: "left", scale: 150, roughness: 0.6, fiber: 0, seed: 1 });
  });

  it("carries `at` through, and defaults it by absence", () => {
    const [mid] = effects([{ type: "torn-edge", side: "top", at: 0.4 }]);
    expect(mid).toMatchObject({ at: 0.4 });
    const [def] = effects([{ type: "torn-edge", side: "top" }]);
    expect("at" in def).toBe(false);
  });

  it("keeps every form's settings, and reads two end positions as a tilt", () => {
    // All three forms share one slot: a loop keeps the edge's side and position,
    // and an edge keeps the loop's margins, so flipping between them costs nothing.
    const [h] = effects([{ type: "tear", form: "hole", side: "top", at: 0.4, inset: 30 }]);
    expect(h).toMatchObject({ type: "tear", form: "hole", side: "top", at: 0.4, inset: 30 });
    const [b] = effects([{ type: "tear", side: "right", inset: [10, 20, 30, 40] }]);
    expect(b).toMatchObject({ inset: [10, 20, 30, 40] });

    const [tilt] = effects([{ type: "tear", side: "right", at: [0, 0.4] }]);
    expect(tilt).toMatchObject({ side: "right", at: [0, 0.4] });
    // A "pair" that is not two numbers is not a tilt: dropped whole, so the
    // break stays parallel to its edge.
    const [bad] = effects([{ type: "tear", side: "right", at: [0.4] }]);
    expect("at" in bad).toBe(false);
  });

  it("reads the retired spellings as the same tear", () => {
    const [old] = effects([{ type: "edge", side: "top" }]);
    expect(old).toMatchObject({ type: "tear", side: "top" });
    const [cut] = effects([{ type: "tear", hole: "cut" }]);
    expect(cut).toMatchObject({ type: "tear", form: "hole" });
    const [scrap] = effects([{ type: "tear", hole: "scrap" }]);
    expect(scrap).toMatchObject({ type: "tear", form: "scrap" });
  });

  it("keeps `inset` on either form, as a percentage", () => {
    const [cut] = effects([{ type: "tear", side: "top", form: "hole", inset: 40 }]);
    expect(cut).toMatchObject({ form: "hole", inset: 40 });
    const [open] = effects([{ type: "tear", side: "top", inset: 40 }]);
    expect(open).toMatchObject({ inset: 40 });
    expect("form" in open).toBe(false);
    // Past 100 is not a margin, it is past the far edge.
    const [wild] = effects([{ type: "tear", side: "top", form: "hole", inset: [0, 40, 400, 20] }]);
    expect(wild).toMatchObject({ inset: [0, 40, 100, 20] });
  });

  it("is a normal effect for the stack: enabled flips, two compose", () => {
    const both = effects([
      { type: "torn-edge", side: "right", enabled: false },
      { type: "torn-edge", side: "bottom" }
    ]);
    expect(both).toHaveLength(2);
    expect(both[0].enabled).toBe(false);
  });

  it("does not roll dice: the same file normalizes to the same seed", () => {
    const raw = [{ type: "torn-edge", side: "right" }];
    expect(normalizeEffects(raw)).toEqual(normalizeEffects(raw));
  });
});

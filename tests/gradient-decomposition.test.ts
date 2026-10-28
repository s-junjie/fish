import { describe, it, expect } from "vitest";
import { diamondQuadrants, angularSectors } from "../src/core/geometry/gradient-decomposition";
import type { Paint } from "../src/core/dsl/types";

const diamond = (over: Partial<Extract<Paint, { type: "diamond-gradient" }>> = {}) =>
  ({
    type: "diamond-gradient",
    from: "#FFFFFF",
    to: "#000000",
    ...over
  }) as Paint;

const angular = (over: Partial<Extract<Paint, { type: "angular-gradient" }>> = {}) =>
  ({
    type: "angular-gradient",
    from: "#FFFFFF",
    to: "#000000",
    ...over
  }) as Paint;

describe("diamondQuadrants", () => {
  it("puts the gradient axis normal to the diamond edge, even when that leaves the box", () => {
    // The worked example from docs/PLAN-angular-diamond-gradients.md §1.2:
    // a 200x100 box, centred, semi-axes rx = ry = 0.5 (so a = 100, b = 50).
    // For the (dx >= 0, dy <= 0) quadrant tMax = 2 and the axis must end at
    // (140, -30) — outside the box, because the axis is perpendicular to the
    // diamond edge rather than aimed at the corner.
    const geo = diamondQuadrants(diamond({ rx: 0.5, ry: 0.5 }), 200, 100, 0);
    expect(geo.cx).toBe(100);
    expect(geo.cy).toBe(50);

    const q = geo.quadrants.find((x) => x.x2 > geo.cx && x.y2 < geo.cy);
    expect(q).toBeDefined();
    expect(Math.round(q!.x2)).toBe(140);
    expect(Math.round(q!.y2)).toBe(-30);
  });

  it("evaluates to the metric: v = t / tMax at the quadrant's far corner", () => {
    const W = 200;
    const H = 100;
    const geo = diamondQuadrants(diamond({ rx: 0.5, ry: 0.5 }), W, H, 0);
    const a = 0.5 * W;
    const b = 0.5 * H;
    for (const q of geo.quadrants) {
      const sx = Math.sign(q.x2 - geo.cx);
      const sy = Math.sign(q.y2 - geo.cy);
      const corner = { x: sx > 0 ? W : 0, y: sy > 0 ? H : 0 };
      const tMax = Math.abs(corner.x - geo.cx) / a + Math.abs(corner.y - geo.cy) / b;

      // Re-derive the SVG gradient value at the corner: (P1->P) . (P1->P2) / |P1->P2|^2
      const dx = corner.x - q.x1;
      const dy = corner.y - q.y1;
      const ux = q.x2 - q.x1;
      const uy = q.y2 - q.y1;
      const v = (dx * ux + dy * uy) / (ux * ux + uy * uy);
      expect(v).toBeCloseTo(1, 6);

      // And at the mid-edge point of the diamond, where t = 1, v = 1 / tMax.
      const mid = { x: geo.cx + sx * a * 0.5, y: geo.cy + sy * b * 0.5 };
      const mdx = mid.x - q.x1;
      const mdy = mid.y - q.y1;
      const vm = (mdx * ux + mdy * uy) / (ux * ux + uy * uy);
      expect(vm).toBeCloseTo(1 / tMax, 6);
    }
  });

  it("splits a centred diamond into all four quadrants", () => {
    const geo = diamondQuadrants(diamond(), 100, 100, 0);
    expect(geo.quadrants).toHaveLength(4);
  });

  it("drops the quadrants that have no area when the centre sits on an edge", () => {
    const geo = diamondQuadrants(diamond({ center: { x: 0, y: 0 } }), 100, 100, 0);
    expect(geo.quadrants).toHaveLength(1);
  });

  it("remaps stop offsets onto each quadrant's own extent and closes the ramp", () => {
    const geo = diamondQuadrants(
      diamond({ rx: 0.5, ry: 0.5, stops: [{ color: "#FF0000", offset: 0 }, { color: "#0000FF", offset: 1 }] }),
      200,
      100,
      0
    );
    for (const q of geo.quadrants) {
      expect(q.stops[0].offset).toBe(0);
      expect(q.stops[q.stops.length - 1].offset).toBe(1);
    }
  });
});

describe("angularSectors", () => {
  it("covers the full turn with no gap and no overlap beyond the seam", () => {
    const sectors = angularSectors(angular(), 240, 240, 0);
    expect(sectors.length).toBeGreaterThanOrEqual(32);
    for (const s of sectors) expect(s.d).toMatch(/^M .* Z$/);
  });

  it("starts every sector ramp on the colour the previous one ended on", () => {
    // Endpoint continuity is what keeps the fan from banding: sector i's last
    // stop and sector i+1's first stop are the same angle, hence the same colour.
    const sectors = angularSectors(
      angular({ stops: [{ color: "#FF0000", offset: 0 }, { color: "#0000FF", offset: 0.5 }, { color: "#00FF00", offset: 1 }] }),
      240,
      240,
      0
    );
    for (let i = 0; i < sectors.length - 1; i++) {
      const end = sectors[i].stops[sectors[i].stops.length - 1];
      const next = sectors[i + 1].stops[0];
      expect(end.offset).toBe(1);
      expect(next.offset).toBe(0);
      expect(end.color).toBe(next.color);
    }
  });

  it("keeps a hard stop hard by inserting it at its exact position", () => {
    // A two-stop hard edge at 37% / 38% — an offset chosen to fall strictly
    // inside one sector rather than on a boundary. Smeared across the whole
    // sector the two colours would interpolate over 4.5deg of arc; inserted,
    // they sit ~1.25deg apart in the same sector's stop list.
    const sectors = angularSectors(
      angular({
        stops: [
          { color: "#FF0000", offset: 0 },
          { color: "#0000FF", offset: 0.37 },
          { color: "#00FF00", offset: 0.38 },
          { color: "#00FF00", offset: 1 }
        ]
      }),
      240,
      240,
      0
    );
    // `sampleGradientAt` returns lower-case hex, so sampled colours are compared
    // case-insensitively against the authored ones.
    const is = (c: string, hex: string) => c.toLowerCase() === hex.toLowerCase();

    // Walk the fan back into sweep coordinates: a stop at fraction `s` of
    // sector `i` sits at (i + s) / count of the full turn.
    const count = sectors.length;
    let blueAt: number | undefined;
    let greenAt: number | undefined;
    for (let i = 0; i < count; i++) {
      for (const st of sectors[i].stops) {
        const g = (i + st.offset) / count;
        if (blueAt === undefined && is(st.color, "#0000FF")) blueAt = g;
        if (greenAt === undefined && is(st.color, "#00FF00")) greenAt = g;
      }
    }

    // Both ends of the hard edge appear at their authored angles rather than
    // being interpolated away across a whole sector.
    expect(blueAt).toBeCloseTo(0.37, 2);
    expect(greenAt).toBeCloseTo(0.38, 2);
    // The transition is the authored 1% of the sweep. A 1% hard edge may
    // straddle up to three sectors when the sector count is high; the test
    // asserts it is not smeared across a whole sector.
    expect(greenAt! - blueAt!).toBeLessThanOrEqual(3 / count + 1e-9);
  });

  it("scales the sector count with the rendered size", () => {
    expect(angularSectors(angular(), 24, 24, 0).length).toBe(32);
    expect(angularSectors(angular(), 600, 600, 0).length).toBe(360);
  });

  it("inflates the sweep radius to cover a padded tile", () => {
    const tight = angularSectors(angular(), 100, 100, 0);
    const padded = angularSectors(angular(), 100, 100, 20);
    const radiusOf = (d: string) => Number(d.match(/A ([\d.]+)/)![1]);
    expect(radiusOf(padded[0].d)).toBeGreaterThan(radiusOf(tight[0].d));
  });
});

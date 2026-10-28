import { describe, it, expect } from "vitest";
import { getActivePage, updateActivePageElements } from "../src/core/dsl/types";
import { fitRingToEdges } from "../src/core/geometry/curve-fit";
import {
  rectRing,
  ellipseRing,
  booleanRings,
  ringsToPathData,
  elementToRings,
  performBooleanOperation
} from "../src/core/geometry/boolean-ops";
import { parsePathData, scalePathData, serializePathData } from "../src/core/geometry/path-data";
import { cubicAt, quadAt } from "../src/core/geometry/path-ops";
import { DesignDocument } from "../src/core/dsl/types";
import { createEmptyDocument } from "../src/core/data-bridge";

type Ring = [number, number][];

const closed = (pts: Ring): Ring => [...pts, pts[0]];

function samplePath(d: string): [number, number][] {
  const model = parsePathData(d)!;
  const out: [number, number][] = [[model.anchors[0].x, model.anchors[0].y]];
  for (const seg of model.segments) {
    const a = model.anchors[seg.a];
    const b = model.anchors[seg.b];
    if (seg.kind === "line") {
      out.push([b.x, b.y]);
      continue;
    }
    for (let i = 1; i <= 24; i++) {
      const t = i / 24;
      const q = seg.kind === "quad" ? quadAt(a, seg.c, b, t) : cubicAt(a, seg.ca, seg.cb, b, t);
      out.push([q.x, q.y]);
    }
  }
  return out;
}

function pointSegmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/**
 * Largest gap between the fitted path and the polyline it replaces.
 *
 * The samples are put back into world space first: `d` is element-local, so
 * comparing it against a world-space ring without the offset would measure the
 * element's position rather than the fit.
 */
function maxDeviation(d: string, ring: Ring, origin: { x: number; y: number } = { x: 0, y: 0 }): number {
  const segs = ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as [[number, number], [number, number]]);
  let worst = 0;
  for (const [sx, sy] of samplePath(d)) {
    const pt: [number, number] = [sx + origin.x, sy + origin.y];
    let best = Infinity;
    for (const [a, b] of segs) best = Math.min(best, pointSegmentDistance(pt, a, b));
    if (best > worst) worst = best;
  }
  return worst;
}

const circle = (cx: number, cy: number, r: number, steps = 80): Ring =>
  Array.from({ length: steps }, (_, i) => {
    const a = (2 * Math.PI * i) / steps;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });

describe("curve fitting recovers Béziers from boolean polygons", () => {
  it("keeps a rectangle as four straight edges", () => {
    const fitted = fitRingToEdges(closed(rectRing(0, 0, 100, 100)))!;
    expect(fitted.edges).toHaveLength(4);
    expect(fitted.edges.every((e) => e.kind === "line")).toBe(true);
  });

  it("does not round off a rectangle's corners", () => {
    // A symmetric cubic can pass through all three points of a right angle while
    // drawing a smooth diagonal between the outer two, so fitting on deviation
    // alone turns a rectangle into a lens. Corners have to be forced.
    const d = ringsToPathData(booleanRings("union", [rectRing(0, 0, 100, 100), rectRing(50, 0, 100, 100)]))!.d;
    // The closing edge is real, which is why `parsePathData` collapses the
    // repeated final anchor via `zc` on the way back in.
    expect(d).toBe("M 0 0 L 150 0 L 150 100 L 0 100 L 0 0 Z");
  });

  it("refits a circle as cubics rather than an 80-gon", () => {
    const fitted = fitRingToEdges(closed(circle(50, 50, 50)))!;
    expect(fitted.edges.length).toBeLessThan(20);
    expect(fitted.edges.filter((e) => e.kind === "cubic").length).toBeGreaterThanOrEqual(8);
  });

  it("stays within a fraction of a pixel of its source across shapes", () => {
    const cases: Array<[string, Ring]> = [
      ["circle", closed(circle(50, 50, 50))],
      ["ellipse", closed(ellipseRing(50, 50, 40, 25))],
      ["rounded rect", closed(rectRing(0, 0, 100, 40, [12, 12, 12, 12]))],
      ["rect", closed(rectRing(0, 0, 100, 40))]
    ];
    for (const [name, ring] of cases) {
      const path = ringsToPathData([ring])!;
      expect(maxDeviation(path.d, ring, { x: path.x, y: path.y }), `${name} deviation`).toBeLessThan(0.2);
    }
  });

  it("emits d in the element's own coordinates, not the world's", () => {
    // A `d` written in world coordinates renders at (x + d.x, y + d.y), so a shape
    // drawn at (200, 200) would land at (400, 400) — off screen, which reads as
    // the boolean having deleted the selection rather than merged it.
    const rings = booleanRings("union", [rectRing(200, 200, 200, 150), rectRing(320, 260, 200, 150)]);
    const path = ringsToPathData(rings)!;
    const model = parsePathData(path.d)!;
    expect(path.x).toBe(200);
    expect(path.y).toBe(200);
    expect(path.width).toBe(320);
    expect(path.height).toBe(210);
    expect(model.anchors.every((a) => a.x >= 0 && a.y >= 0 && a.x <= 320 && a.y <= 210)).toBe(true);
    expect(Math.min(...model.anchors.map((a) => a.x))).toBe(0);
    expect(Math.min(...model.anchors.map((a) => a.y))).toBe(0);
    // And it survives a move, which is what the offset would break.
    expect(scalePathData(model, 2, 2).anchors[0].x).toBe(0);
  });

  it("survives a parse/serialize round trip unchanged", () => {
    const rings = booleanRings("intersect", [rectRing(0, 0, 100, 100), ellipseRing(50, 50, 50, 50)]);
    const d = ringsToPathData(rings)!.d;
    expect(serializePathData(parsePathData(d)!)).toBe(d);
  });

  it("emits one subpath per result ring", () => {
    const rings = booleanRings("subtract", [rectRing(0, 0, 100, 100), ellipseRing(50, 50, 30, 30)]);
    expect(rings).toHaveLength(2);
    const d = ringsToPathData(rings)!.d;
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("reads a compound path as separate rings so a hole survives", () => {
    const el = {
      id: "p",
      type: "path" as const,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      d: "M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z"
    };
    expect(elementToRings(el)).toHaveLength(2);
  });

  it("marks a boolean result even-odd so a hole reads as a hole", () => {
    const doc: DesignDocument = updateActivePageElements(createEmptyDocument(), [
      { id: "a", type: "rect", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", type: "ellipse", x: 20, y: 20, width: 60, height: 60 }
    ]);
    const { doc: next } = performBooleanOperation(doc, new Set(["a", "b"]), "subtract");
    expect((getActivePage(next).children[0] as any).fillRule).toBe("evenodd");
  });
});

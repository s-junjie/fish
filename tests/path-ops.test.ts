import { describe, it, expect } from "vitest";
import {
  splitSubpaths,
  insertAnchorAt,
  flattenPathData,
  flattenPathString,
  flattenElement,
  nearestPointOnPath,
  resolvePenTarget,
  applyPenTarget
} from "../src/core/geometry/path-ops";
import { parsePathData, serializePathData } from "../src/core/geometry/path-data";
import { rectToVectorPath, ellipseToVectorPath } from "../src/core/geometry/path-convert";
import { RectElement, EllipseElement } from "../src/core/dsl/types";

describe("splitSubpaths", () => {
  it("reads an outline with a hole as two subpaths", () => {
    const model = parsePathData("M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z")!;
    const parts = splitSubpaths(model);
    expect(parts).toHaveLength(2);
    expect(parts[0].anchors).toHaveLength(4);
    expect(parts[1].anchors).toHaveLength(4);
  });

  it("leaves a single-subpath path whole", () => {
    expect(splitSubpaths(parsePathData("M 0 0 L 10 0 L 10 10 Z")!)).toHaveLength(1);
  });
});

describe("insertAnchorAt", () => {
  it("splits a cubic at the exact de Casteljau point", () => {
    const after = insertAnchorAt(parsePathData("M 0 0 C 0 50 100 50 100 0")!, 0, 0.5);
    expect(after.anchors).toHaveLength(3);
    expect(after.segments).toHaveLength(2);
    expect(after.segments.map((s) => s.kind)).toEqual(["cubic", "cubic"]);
    // Anchors stay in traversal order, which is what every other path operation
    // and the serializer read.
    expect(after.anchors[1]).toEqual({ x: 50, y: 37.5 });
    expect(after.segments[0]).toMatchObject({ a: 0, b: 1, ca: { x: 0, y: 25 }, cb: { x: 25, y: 37.5 } });
    expect(after.segments[1]).toMatchObject({ a: 1, b: 2, ca: { x: 75, y: 37.5 }, cb: { x: 100, y: 25 } });
  });

  it("splits a quad the same way", () => {
    const after = insertAnchorAt(parsePathData("M 0 0 Q 50 100 100 0")!, 0, 0.5);
    expect(serializePathData(after)).toBe("M 0 0 Q 25 50 50 50 Q 75 50 100 0");
  });

  it("leaves the drawn curve unchanged", () => {
    const before = parsePathData("M 0 0 C 0 50 100 50 100 0")!;
    const after = insertAnchorAt(before, 0, 0.5);
    const draw = (d: string) => {
      const m = parsePathData(d)!;
      return m.segments.flatMap((seg) => {
        if (seg.kind !== "cubic") return [];
        const a = m.anchors[seg.a];
        const b = m.anchors[seg.b];
        return Array.from({ length: 401 }, (_, i) => {
          const t = i / 400;
          const u = 1 - t;
          return {
            x: u * u * u * a.x + 3 * u * u * t * seg.ca.x + 3 * u * t * t * seg.cb.x + t * t * t * b.x,
            y: u * u * u * a.y + 3 * u * u * t * seg.ca.y + 3 * u * t * t * seg.cb.y + t * t * t * b.y
          };
        });
      });
    };
    // Dense samples of the two paths do not land on each other, so the bound is
    // the sampling step rather than zero.
    const ref = draw(serializePathData(before));
    for (const p of draw(serializePathData(after))) {
      const near = Math.min(...ref.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
      expect(near).toBeLessThan(0.5);
    }
  });

  it("gives the inserted anchor collinear handles", () => {
    const after = insertAnchorAt(parsePathData("M 0 0 C 0 50 100 50 100 0")!, 0, 0.5);
    const mid = after.anchors[1];
    const inSeg = after.segments[0] as any;
    const outSeg = after.segments[1] as any;
    const cross =
      (inSeg.cb.x - mid.x) * (outSeg.ca.y - mid.y) - (inSeg.cb.y - mid.y) * (outSeg.ca.x - mid.x);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
  });

  it("splits a synthetic closepath, inserting an anchor and keeping the path closed", () => {
    const model = parsePathData("M 0 0 L 10 0 L 10 10 Z")!;
    const zIdx = model.segments.findIndex((s) => s.kind === "line" && s.z);
    expect(zIdx).toBeGreaterThanOrEqual(0);
    const after = insertAnchorAt(model, zIdx, 0.5);
    expect(after.anchors).toHaveLength(4);
    expect(after.anchors[3]).toEqual({ x: 5, y: 5 });
    expect(after.segments[3].kind).toBe("line");
    expect((after.segments[3] as any).z).toBe(true);
    expect(after.closed).toBe(true);
  });
});

describe("flattenPathData", () => {
  it("leaves an already-polygonal path alone", () => {
    const d = "M 0 0 L 10 0 L 10 10 Z";
    expect(flattenPathString(d)).toBe(d);
  });

  it("removes every curve", () => {
    const flat = flattenPathString("M 0 0 C 0 50 100 50 100 0")!;
    expect(flat).not.toContain("C");
    expect(flat).not.toContain("Q");
    const model = parsePathData(flat)!;
    expect(model.segments.every((s) => s.kind === "line")).toBe(true);
  });

  it("keeps a closed path closed and keeps holes", () => {
    const model = parsePathData("M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z")!;
    const flat = flattenPathData(model);
    expect(flat.closed).toBe(true);
    expect(splitSubpaths(flat)).toHaveLength(2);
  });

  it("samples a short curve far more finely than a long one", () => {
    const short = flattenPathData(parsePathData("M 0 0 C 0 6 6 6 6 0")!).anchors.length;
    const long = flattenPathData(parsePathData("M 0 0 C 0 600 600 600 600 0")!).anchors.length;
    expect(long).toBeGreaterThan(short * 4);
  });
});

describe("nearestPointOnPath", () => {
  it("reports where a click lands on the nearest segment", () => {
    const model = parsePathData("M 0 0 L 100 0")!;
    const hit = nearestPointOnPath(model, { x: 40, y: 30 })!;
    expect(hit.segIdx).toBe(0);
    expect(hit.point.x).toBeCloseTo(40, 1);
    expect(hit.point.y).toBeCloseTo(0, 5);
  });

  it("follows a curve rather than its chord", () => {
    const model = parsePathData("M 0 0 C 0 100 100 100 100 0")!;
    const hit = nearestPointOnPath(model, { x: 50, y: 75 })!;
    expect(hit.point.y).toBeGreaterThan(60);
  });
});

describe("flattenElement", () => {
  it("converts a parametric shape to a path before flattening it", () => {
    const rect: RectElement = { id: "r", type: "rect", name: "R", x: 0, y: 0, width: 20, height: 10 };
    const out = flattenElement(rect);
    expect(out.type).toBe("path");
    expect((out as any).d).not.toContain("C");
  });

  it("turns an ellipse into a polygon of the same box", () => {
    const ellipse: EllipseElement = { id: "e", type: "ellipse", name: "E", x: 0, y: 0, width: 100, height: 100 };
    const out = flattenElement(ellipse) as any;
    expect(out.d).not.toContain("C");
    expect(out.width).toBeGreaterThan(90);
    expect(out.height).toBeGreaterThan(90);
  });

  it("actually flattens a parametric ellipse, which is what it is for", () => {
    // `ellipseToVectorPath` speaks SVG arcs, so this path is only ever curves in
    // the first place. A guard that asks the OUTPUT whether it is already
    // polygonal fires on every curve, because flattening makes that true — which
    // is how Flatten ended up a no-op.
    const ellipse: EllipseElement = { id: "e", type: "ellipse", name: "E", x: 300, y: 300, width: 200, height: 120 };
    const out = flattenElement(ellipse) as any;
    expect(out.type).toBe("path");
    expect(out.d).not.toMatch(/[CQASTHV]/);
    expect(parsePathData(out.d)!.segments.every((s) => s.kind === "line")).toBe(true);
    expect(out.x).toBeCloseTo(300, 1);
    expect(out.y).toBeCloseTo(300, 1);
  });

  it("passes through elements that have no path geometry", () => {
    const frame: any = { id: "f", type: "frame", name: "F", x: 0, y: 0, width: 10, height: 10 };
    expect(flattenElement(frame)).toBe(frame);
  });

  it("leaves a polygonal path's box alone", () => {
    const path: any = {
      id: "p",
      type: "path",
      name: "P",
      x: 5,
      y: 5,
      width: 10,
      height: 10,
      d: "M 0 0 L 10 0 L 10 10 L 0 10 Z"
    };
    const out = flattenElement(path);
    expect(out).toEqual(path);
  });
});

describe("round trips through flatten", () => {
  it("survives parse/serialize unchanged", () => {
    const d = "M 0 0 C 0 50 100 50 100 0 Z";
    const flat = flattenPathString(d)!;
    expect(serializePathData(parsePathData(flat)!)).toBe(flat);
  });

  it("flattens the shape a converted rect describes", () => {
    const rect: RectElement = { id: "r", type: "rect", name: "R", x: 0, y: 0, width: 20, height: 10, borderRadius: 4 };
    const converted = rectToVectorPath(rect);
    const flat = flattenPathString(converted)!;
    expect(flat).not.toContain("C");
  });

  it("flattens the shape a converted ellipse describes", () => {
    const ellipse: EllipseElement = { id: "e", type: "ellipse", name: "E", x: 0, y: 0, width: 40, height: 20 };
    const flat = flattenPathString(ellipseToVectorPath(ellipse))!;
    expect(flat).not.toContain("C");
  });
});

describe("applyPenTarget", () => {
  it("does not insert an anchor in add mode when click is near an existing anchor", () => {
    const model = parsePathData("M 0 0 L 100 0 L 100 100 Z")!;
    // Click directly on anchor 0 (0, 0)
    const targetOnAnchor = resolvePenTarget(model, { x: 0, y: 0 }, 10)!;
    expect(targetOnAnchor).not.toBeNull();
    expect(targetOnAnchor.anchorDist).toBe(0);
    expect(applyPenTarget(targetOnAnchor, "add", 10)).toBeNull();

    // Click near anchor 1 (100, 0) within reach
    const targetNearAnchor = resolvePenTarget(model, { x: 98, y: 0 }, 10)!;
    expect(targetNearAnchor).not.toBeNull();
    expect(targetNearAnchor.anchorDist).toBeLessThanOrEqual(10);
    expect(applyPenTarget(targetNearAnchor, "add", 10)).toBeNull();
  });

  it("inserts an anchor in add mode when click is along an edge away from existing anchors", () => {
    const model = parsePathData("M 0 0 L 100 0 L 100 100 Z")!;
    const targetOnEdge = resolvePenTarget(model, { x: 50, y: 0 }, 10)!;
    expect(targetOnEdge).not.toBeNull();
    expect(targetOnEdge.anchorDist).toBeGreaterThan(10);
    const updated = applyPenTarget(targetOnEdge, "add", 10);
    expect(updated).not.toBeNull();
    expect(updated!.anchors).toHaveLength(4);
    expect(updated!.anchors[1].x).toBeCloseTo(50, 1);
    expect(updated!.anchors[1].y).toBeCloseTo(0, 1);
  });

  it("removes an anchor in remove mode when click is within reach", () => {
    const model = parsePathData("M 0 0 L 50 0 L 100 0 L 100 100 Z")!;
    const target = resolvePenTarget(model, { x: 50, y: 0 }, 10)!;
    const updated = applyPenTarget(target, "remove", 10);
    expect(updated).not.toBeNull();
    expect(updated!.anchors).toHaveLength(3);
  });
});

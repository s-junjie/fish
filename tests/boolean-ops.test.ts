import { describe, it, expect } from "vitest";
import { DesignElement } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/types";
import {
  rectRing,
  ellipseRing,
  booleanRings,
  ringsToPathData,
  performBooleanOperation,
  elementToRings
} from "../src/core/geometry/boolean-ops";
import { DesignDocument, updateActivePageElements } from "../src/core/dsl/types";
import { createEmptyDocument } from "../src/core/data-bridge";

type Pts = [number, number][];

function boundsOf(rings: Pts[]) {
  const xs = rings.flatMap((r) => r.map((p) => p[0]));
  const ys = rings.flatMap((r) => r.map((p) => p[1]));
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const square = (rotation?: number) =>
  ({ id: rotation ? "turned" : "plain", type: "rect", x: 0, y: 0, width: 100, height: 100, ...(rotation ? { rotation } : {}) }) as DesignElement;

describe("FISH Boolean Operations Engine", () => {
  it("computes union between two overlapping rectangles", () => {
    // r1 at (0, 0, 100, 100), r2 at (50, 0, 100, 100)
    const r1 = rectRing(0, 0, 100, 100);
    const r2 = rectRing(50, 0, 100, 100);
    const unionRings = booleanRings("union", [r1, r2]);
    const path = ringsToPathData(unionRings);

    expect(path).toBeDefined();
    expect(path!.x).toBe(0);
    expect(path!.y).toBe(0);
    expect(path!.width).toBe(150);
    expect(path!.height).toBe(100);
    expect(path!.d).toContain("M");
    expect(path!.d).toContain("Z");
  });

  it("computes difference (subtract) between two overlapping rectangles", () => {
    const r1 = rectRing(0, 0, 100, 100);
    const r2 = rectRing(50, 0, 100, 100);
    const diffRings = booleanRings("subtract", [r1, r2]);
    const path = ringsToPathData(diffRings);

    expect(path).toBeDefined();
    expect(path!.width).toBe(50);
    expect(path!.height).toBe(100);
  });

  it("computes intersection between rectangle and ellipse", () => {
    const r1 = rectRing(0, 0, 100, 100);
    const e1 = ellipseRing(50, 50, 50, 50);
    const intRings = booleanRings("intersect", [r1, e1]);
    const path = ringsToPathData(intRings);

    expect(path).toBeDefined();
    expect(path!.width).toBeGreaterThan(0);
    expect(path!.height).toBeGreaterThan(0);
  });

  it("performs boolean operation on DesignDocument elements transactionally", () => {
    const doc: DesignDocument = updateActivePageElements(createEmptyDocument(), [
      { id: "box1", type: "rect", x: 0, y: 0, width: 100, height: 100 },
      { id: "box2", type: "rect", x: 50, y: 0, width: 100, height: 100 }
    ]);

    const { doc: newDoc, newElementId } = performBooleanOperation(doc, new Set(["box1", "box2"]), "union");
    expect(getActivePage(newDoc).children.length).toBe(1);
    expect(getActivePage(newDoc).children[0].type).toBe("path");
    expect(getActivePage(newDoc).children[0].id).toBe(newElementId);
  });

  it("reads a turned element's outline where it is painted, not where its box is stored", () => {
    const b = boundsOf(elementToRings(square(45)));
    const span = 100 * Math.SQRT2;
    expect(b.width).toBeCloseTo(span, 3);
    expect(b.height).toBeCloseTo(span, 3);
    expect(b.x).toBeCloseTo(50 - span / 2, 3);
    expect(b.y).toBeCloseTo(50 - span / 2, 3);
  });

  it("subtracts a turned twin instead of reading it as the same square", () => {
    const doc: DesignDocument = updateActivePageElements(createEmptyDocument(), [square(), square(45)]);
    const { doc: next, newElementId } = performBooleanOperation(doc, new Set(["plain", "turned"]), "subtract");
    expect(newElementId).not.toBeNull();
    const path = getActivePage(next).children[0];
    expect(path.type).toBe("path");
    // The diamond takes the square's middle, leaving one triangle per corner.
    expect(((path as { d: string }).d.match(/M/g) || []).length).toBe(4);
  });

  it("unions a turned element into the envelope it covers", () => {
    const doc: DesignDocument = updateActivePageElements(createEmptyDocument(), [square(), square(45)]);
    const { doc: next, newElementId } = performBooleanOperation(doc, new Set(["plain", "turned"]), "union");
    expect(newElementId).not.toBeNull();
    const path = getActivePage(next).children[0] as { x: number; y: number; width: number; height: number; rotation?: number };
    const span = 100 * Math.SQRT2;
    expect(path.width).toBeCloseTo(span, 3);
    expect(path.height).toBeCloseTo(span, 3);
    expect(path.rotation ?? 0).toBe(0);
  });

  it("mirrors a flipped element's outline about its box centre", () => {
    const tri = (flipX?: boolean) =>
      ({
        id: flipX ? "flipped" : "plain",
        type: "path",
        x: 0,
        y: 0,
        width: 60,
        height: 100,
        d: "M0 0 L60 100 L0 100 Z",
        ...(flipX ? { flipX } : {})
      }) as DesignElement;
    const plain = boundsOf(elementToRings(tri()));
    const flipped = boundsOf(elementToRings(tri(true)));
    expect(flipped.width).toBeCloseTo(plain.width, 3);
    // The hypotenuse changes sides: the mirror is about the box centre, so the
    // outline's centroid switches from the top-left to the top-right half.
    expect(flipped.x).toBeCloseTo(plain.x, 3);
    const centroidX = (rings: Pts[]) => {
      const pts = rings.flat();
      return pts.reduce((s, p) => s + p[0], 0) / pts.length;
    };
    expect(centroidX(elementToRings(tri(true)))).toBeGreaterThan(centroidX(elementToRings(tri())));
  });
});

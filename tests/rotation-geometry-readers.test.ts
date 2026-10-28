import { describe, expect, it } from "vitest";
import { identityMatrix, multiply, transformPoint, type Matrix2D } from "../src/core/geometry/matrix";
import { transformBoundsToAABB } from "../src/core/geometry/bounds";
import { elementPivot, elementTransformMatrix } from "../src/core/geometry/transforms";
import { elementAABB, elementRotatedAABB } from "../src/core/geometry/element-bounds";
import {
  computeParentWorldMatrix,
  findElementAtPoint,
  findFrameAtPoint,
  findParentFrameForBox
} from "../src/core/geometry/tree-ops";
import { contentBounds, worldSubtreeBounds } from "../src/core/geometry/element-bounds";
import { measureDocument } from "../src/core/measure";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * The rest of the canvas asks the same question the selection box does — "where
 * does this layer paint, and what is its box" — and most of it was asking it
 * through a sum of `x`/`y`.
 *
 * That answer is right until an ancestor is turned, because the renderer draws a
 * child inside its frame's turned group. These are the readers that were wrong:
 * hit testing, drop targeting, the fit box, culling, and the geometry readback an
 * export crops from. Each one is silent when it is wrong — the layer is simply
 * somewhere else, or does not respond to the pointer — so they are pinned here
 * against the transform the renderer actually performs.
 */

const rect = (id: string, x: number, y: number, w: number, h: number, extra: object = {}): DesignElement =>
  ({ id, type: "rect", name: id, x, y, width: w, height: h, ...extra }) as DesignElement;

const frame = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  children: DesignElement[],
  extra: object = {}
): DesignElement => ({ id, type: "frame", name: id, x, y, width: w, height: h, children, ...extra }) as DesignElement;

const docOf = (elements: DesignElement[]): DesignDocument =>
  normalizeDesignDocument({ version: "0.1", canvas: { width: 1440, height: 4000 }, elements }).document;

/** The renderer, replayed: a node's own turn, then its shift. */
function rendererMatrix(el: DesignElement, parentM: Matrix2D): Matrix2D {
  const pivot = elementPivot(el);
  return multiply(
    parentM,
    multiply(elementTransformMatrix(el, pivot.x, pivot.y), {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: el.x,
      f: el.y
    })
  );
}

function paintedMatrix(elements: DesignElement[], id: string): Matrix2D | null {
  const walk = (list: DesignElement[], parentM: Matrix2D): Matrix2D | null => {
    for (const el of list) {
      const m = rendererMatrix(el, parentM);
      if (el.id === id) return m;
      if (el.type === "frame" || el.type === "component") {
        const hit = walk((el as { children?: DesignElement[] }).children || [], m);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(elements, identityMatrix());
}

function findNode(elements: DesignElement[], id: string): DesignElement | null {
  for (const el of elements) {
    if (el.id === id) return el;
    if (el.type === "frame" || el.type === "component") {
      const hit = findNode((el as { children?: DesignElement[] }).children || [], id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The box `id` PAINTS, in canvas space.
 *
 * `paintedMatrix` maps a node's LOCAL shape coords (0,0 … w,h) to canvas, so the
 * box has to be given in those coords — handing it `elementAABB`, which already
 * carries the node's own `x`/`y`, applies that shift twice.
 */
function paintedBox(elements: DesignElement[], id: string) {
  const el = findNode(elements, id)!;
  return transformBoundsToAABB(
    { x: 0, y: 0, width: el.width, height: el.height },
    paintedMatrix(elements, id)!
  )!;
}

/** A point known to be inside `id`, in canvas space, read off the renderer. */
function aPointInside(elements: DesignElement[], id: string): { x: number; y: number } {
  const el = findNode(elements, id)!;
  const m = paintedMatrix(elements, id)!;
  return transformPoint(m, { x: el.width / 2, y: el.height / 2 });
}

/** A point known to be OUTSIDE every node — far off the page. */
const FAR_AWAY = { x: -9999, y: -9999 };

// The reported shape: a turned frame with a turned child inside it.
const turned = () => [
  frame("F", 400, 300, 400, 300, [rect("c", 40, 30, 120, 80, { rotation: 25 })], { rotation: -35 })
];

describe("hit testing under a turned ancestor", () => {
  it("finds the child where it actually paints, not where x/y summed says", () => {
    const els = turned();
    const p = aPointInside(els, "c");
    expect(findElementAtPoint(els, p.x, p.y)?.id).toBe("c");
  });

  it("still finds it on an unturned frame — the common case must not move", () => {
    const els = [frame("F", 400, 300, 400, 300, [rect("c", 40, 30, 120, 80)])];
    const p = aPointInside(els, "c");
    expect(findElementAtPoint(els, p.x, p.y)?.id).toBe("c");
  });

  it("hits a TURNED top-level layer inside its painted corners", () => {
    // The un-rotated AABB of a turned layer includes whole regions nothing
    // paints, so a point in one of them must NOT report the layer.
    const els = [rect("r", 0, 0, 100, 100, { rotation: 45 })];
    const painted = paintedMatrix(els, "r")!;
    // The painted centre is hit…
    const centre = transformPoint(painted, { x: 50, y: 50 });
    expect(findElementAtPoint(els, centre.x, centre.y)?.id).toBe("r");
    // …and the corner of the un-rotated box, which the turn carries away, is not.
    expect(findElementAtPoint(els, 1, 1)).toBeNull();
  });

  it("reports nothing for a point that is on no layer", () => {
    expect(findElementAtPoint(turned(), FAR_AWAY.x, FAR_AWAY.y)).toBeNull();
  });

  it("still skips a locked layer and honours excludeId", () => {
    const els = [rect("a", 0, 0, 100, 100), rect("b", 0, 0, 100, 100, { locked: true })];
    // "b" is on top but locked, so the press belongs to "a".
    expect(findElementAtPoint(els, 50, 50)?.id).toBe("a");
    // Asking to see the lock is how hover previews "a locked layer is on top".
    expect(findElementAtPoint(els, 50, 50, { includeLocked: true })?.id).toBe("b");
    // Excluding "a" leaves only the locked layer, which is still skipped.
    expect(findElementAtPoint(els, 50, 50, { excludeId: "a" })).toBeNull();
    expect(findElementAtPoint(els, 50, 50, { excludeId: "a", includeLocked: true })?.id).toBe("b");
  });
});

describe("drop targeting under a turned ancestor", () => {
  it("routes a drop into the frame that is really under the pointer", () => {
    const els = turned();
    const inside = aPointInside(els, "c");
    expect(findFrameAtPoint(els, inside.x, inside.y)?.id).toBe("F");
    expect(findFrameAtPoint(els, FAR_AWAY.x, FAR_AWAY.y)).toBeNull();
  });

  it("still refuses an excluded frame", () => {
    const els = turned();
    const inside = aPointInside(els, "c");
    expect(findFrameAtPoint(els, inside.x, inside.y, ["F"])).toBeNull();
  });
});

describe("new frame nesting under a turned ancestor", () => {
  it("accepts a box that the frame really contains", () => {
    const els = [frame("F", 400, 300, 400, 300, [rect("c", 10, 10, 50, 50)], { rotation: -35 })];
    // A box at the frame's painted centre is inside it on screen.
    const centre = transformPoint(paintedMatrix(els, "F")!, { x: 200, y: 150 });
    const box = { x: centre.x - 10, y: centre.y - 10, width: 20, height: 20 };
    expect(findParentFrameForBox(els, box)?.id).toBe("F");
  });

  it("still refuses a box outside everything", () => {
    expect(findParentFrameForBox(turned(), { x: -900, y: -900, width: 10, height: 10 })).toBeNull();
  });
});

describe("contentBounds — what zoom-to-fit frames", () => {
  it("frames a turned child where it paints", () => {
    const els = turned();
    const painted = paintedBox(els, "c");
    const bounds = contentBounds(els)!;
    // The child's painted box has to be inside the frame's fit box.
    expect(bounds.x).toBeLessThanOrEqual(painted.x + 0.01);
    expect(bounds.y).toBeLessThanOrEqual(painted.y + 0.01);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(painted.x + painted.width - 0.01);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(painted.y + painted.height - 0.01);
  });

  it("is unchanged for an unturned tree", () => {
    expect(contentBounds([frame("f", 0, 0, 100, 100, [rect("c", 10, 20, 30, 40)])])).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100
    });
  });

  it("still measures a line by its endpoints", () => {
    const line = { id: "l", type: "line", name: "l", x: 100, y: 100, dx: 50, dy: -80, width: 50, height: 80 } as DesignElement;
    expect(contentBounds([line])).toEqual({ x: 100, y: 20, width: 50, height: 80 });
  });
});

describe("worldSubtreeBounds — what culling tests against the viewport", () => {
  it("puts a turned child's subtree box where it paints", () => {
    const els = turned();
    const painted = paintedBox(els, "c");
    const box = worldSubtreeBounds(els).get("c")!;
    expect(box.x).toBeCloseTo(painted.x, 6);
    expect(box.y).toBeCloseTo(painted.y, 6);
  });

  it("keeps a visible child of a turned frame visible", () => {
    // The regression in one line: measured the old way the box sat at an offset
    // the canvas never painted, so a child could be culled while on screen.
    const els = turned();
    const box = worldSubtreeBounds(els).get("c")!;
    expect(box.width).toBeGreaterThan(0);
    expect(Number.isFinite(box.x)).toBe(true);
  });
});

describe("measureDocument — the geometry readback an export crops from", () => {
  it("reports a turned child in canvas coordinates", () => {
    const els = turned();
    const painted = paintedBox(els, "c");
    const node = measureDocument(docOf(els)).find((n) => n.id === "c")!;
    expect(node.x).toBeCloseTo(painted.x, 6);
    expect(node.y).toBeCloseTo(painted.y, 6);
  });

  it("keeps `local` as the parent-relative box, which is a different answer", () => {
    // Two fields, two contracts: `x`/`y` is where it paints, `local` is what the
    // document stores. Folding the ancestor chain into `local` would break every
    // caller that reads it as the stored geometry.
    const els = turned();
    const child = findNode(els, "c")!;
    const node = measureDocument(docOf(els)).find((n) => n.id === "c")!;
    expect(node.local).toEqual(elementAABB(child));
    expect(node.local.x).not.toBeCloseTo(node.x, 3);
  });

  it("adds the ancestor origin chain on an unturned tree, unchanged", () => {
    const doc = docOf([frame("page", 100, 200, 800, 600, [frame("card", 24, 32, 300, 100, [rect("c", 8, 16, 40, 20)])])]);
    expect(measureDocument(doc).find((n) => n.id === "c")).toMatchObject({ x: 132, y: 248 });
  });
});

describe("computeParentWorldMatrix", () => {
  it("is a pure shift for an unturned chain", () => {
    const els = [frame("f", 300, 200, 400, 300, [rect("c", 40, 30, 60, 60)])];
    const m = computeParentWorldMatrix(els, "c");
    expect({ x: m.e, y: m.f }).toEqual({ x: 300, y: 200 });
  });

  it("turns with the ancestor", () => {
    const els = [frame("f", 0, 0, 400, 300, [rect("c", 40, 30, 60, 60)], { rotation: 90 })];
    const m = computeParentWorldMatrix(els, "c");
    const p = transformPoint(m, { x: 40, y: 30 });
    const q = transformPoint(m, { x: 140, y: 30 });
    // A 90° turn maps (dx, dy) → (−dy, dx).
    expect(q.y - p.y).toBeCloseTo(100, 6);
    expect(q.x - p.x).toBeCloseTo(0, 6);
  });
});
/**
 * A line is the one shape the envelope question has a second answer for, and the
 * two answers were never reconciled: it turns about its ORIGIN (`elementPivot`),
 * so it paints the turned SEGMENT, while `elementRotatedAABB` was turning its
 * `|dx|`x`|dy|` BOX about the box's centre — a rectangle the line never paints,
 * around a point it never turns about. Every rotated line was reported both too
 * large and in the wrong place, which is what "resize to fit" and drop targeting
 * were silently reading.
 */
describe("a turned line paints its turned segment", () => {
  const line = (dx: number, dy: number, rotation: number): DesignElement =>
    ({
      id: "l",
      type: "line",
      x: 0,
      y: 0,
      width: Math.abs(dx),
      height: Math.abs(dy),
      dx,
      dy,
      rotation
    } as DesignElement);

  /**
   * The truth, derived the slow way: turn the second endpoint about the first —
   * which is the pivot — and bound the two points. Written out rather than
   * imported so this cannot pass by agreeing with itself.
   */
  const truth = (el: DesignElement): { x: number; y: number; width: number; height: number } => {
    const l = el as { dx: number; dy: number; rotation?: number };
    const rad = ((l.rotation || 0) * Math.PI) / 180;
    const u = l.dx * Math.cos(rad) - l.dy * Math.sin(rad);
    const v = l.dx * Math.sin(rad) + l.dy * Math.cos(rad);
    return { x: Math.min(0, u), y: Math.min(0, v), width: Math.abs(u), height: Math.abs(v) };
  };

  const cases: [string, DesignElement][] = [
    ["a diagonal turned onto its own direction", line(100, 100, 45)],
    ["a horizontal turned 45", line(100, 0, 45)],
    ["a vertical turned 45", line(0, 100, 45)],
    ["a diagonal turned 90", line(100, 100, 90)],
    ["a segment pointing backwards", line(-100, 50, 30)]
  ];

  for (const [name, el] of cases) {
    it(`bounds ${name}`, () => {
      const got = elementRotatedAABB(el);
      const want = truth(el);
      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
      expect(got.width).toBeCloseTo(want.width, 6);
      expect(got.height).toBeCloseTo(want.height, 6);
    });
  }

  it("collapses a diagonal onto its own direction rather than inflating it", () => {
    // The old answer was 141.42x141.42 hung at (-20.71, -20.71): the turned box,
    // which the line does not paint. The turned segment covers no width at all.
    const box = elementRotatedAABB(line(100, 100, 45));
    expect(box.width).toBeCloseTo(0, 6);
    expect(box.height).toBeCloseTo(100 * Math.SQRT2, 6);
  });

  it("leaves an unturned line exactly where the plain box does", () => {
    const el = line(100, 100, 0);
    expect(elementRotatedAABB(el)).toEqual(elementAABB(el));
  });

  it("anchors on the FIRST endpoint, not on the box corner", () => {
    // `elementAABB` puts a backwards segment's corner at `min(x, x + dx)`, which
    // is the END it does not turn about. The envelope has to hang off the pivot:
    // 0 here, not -100.
    const box = elementRotatedAABB(line(-100, 0, 90));
    expect(box.x).toBeCloseTo(0, 6);
    expect(box.y).toBeCloseTo(-100, 6);
    expect(box.width).toBeCloseTo(0, 6);
    expect(box.height).toBeCloseTo(100, 6);
  });
});

describe("the fit box bounds a turned line as a segment", () => {
  it("does not inflate it to the turned box", () => {
    // Zoom-to-fit and the presentation page frame read `contentBounds`. Bounding
    // the `|dx|`x`|dy|` box through the rotation gave 141.42x141.42 at (-70.71, 0)
    // for a diagonal turned onto its own direction — a whole segment's length of
    // empty space, which zoomed out to fit nothing.
    const el = {
      id: "l",
      type: "line",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      dx: 100,
      dy: 100,
      rotation: 45,
      strokes: []
    } as DesignElement;
    const box = contentBounds([el])!;
    expect(box.x).toBeCloseTo(0, 6);
    expect(box.y).toBeCloseTo(0, 6);
    expect(box.width).toBeCloseTo(0, 6);
    expect(box.height).toBeCloseTo(100 * Math.SQRT2, 6);
  });
});

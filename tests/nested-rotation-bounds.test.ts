import { describe, expect, it } from "vitest";
import { identityMatrix, multiply, transformPoint, type Matrix2D } from "../src/core/geometry/matrix";
import { elementPivot, elementTransformMatrix } from "../src/core/geometry/transforms";
import { computeParentOrigin, computeParentWorldMatrix } from "../src/core/geometry/tree-ops";
import { worldMatrixOf } from "../src/core/interactions/component-swap";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * A child of a turned frame paints at an angle, and the box drawn around it has
 * to be turned with it.
 *
 * The renderer draws a child INSIDE its frame's rotated `<g>` — the whole
 * subtree inherits the frame's `rotation` — so the position of that child is not
 * a sum of `x`/`y` at all. It used to be computed as one, which is invisible on
 * an unrotated frame and visibly wrong on a turned one: the selection box landed
 * near the artwork, at the wrong angle, separated from it by however far the
 * frame's rotation carried the child.
 *
 * `worldMatrixOf` is the answer that can express it, and these tests hold it
 * against the renderer's own nesting — the composition is replayed from
 * `SvgNodeRenderer` rather than restated, so the two cannot drift apart.
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

const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#FFFFFF" } };

const doc = (elements: DesignElement[]): DesignDocument =>
  ({
    id: "p1",
    name: "Page 1",
    canvas,
    pages: [{ id: "p1", name: "Page 1", canvas, children: elements }],
    activePageId: "p1"
  } as unknown as DesignDocument);

/** The matrix `SvgNodeRenderer` builds: a node's own turn, then its shift. */
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
 * The renderer paints a LOCAL point at `painted · local`; the overlay draws its
 * rect at the coordinates the element STORES, so it lands at `m · (local + x/y)`.
 * Those must be the same point, for every corner.
 */
function expectFramesArtwork(elements: DesignElement[], id: string) {
  const el = findNode(elements, id)!;
  const painted = paintedMatrix(elements, id)!;
  const m = worldMatrixOf(doc(elements), el);
  const corners = [
    { x: 0, y: 0 },
    { x: el.width, y: 0 },
    { x: el.width, y: el.height },
    { x: 0, y: el.height }
  ];
  for (const c of corners) {
    const a = transformPoint(painted, c);
    const b = transformPoint(m, { x: c.x + el.x, y: c.y + el.y });
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  }
}

describe("worldMatrixOf — a turned frame turns its children", () => {
  it("frames a child of a rotated frame", () => {
    // The reported case: the frame and the content are both turned.
    expectFramesArtwork(
      [frame("f", 300, 200, 400, 300, [rect("c", 40, 30, 60, 60, { rotation: 25 })], { rotation: -35 })],
      "c"
    );
  });

  it("frames a child through two levels of rotated ancestors", () => {
    expectFramesArtwork(
      [
        frame(
          "f",
          300,
          200,
          400,
          300,
          [frame("g", 20, 25, 120, 90, [rect("c", 10, 12, 40, 30, { rotation: 15 })], { rotation: 12 })],
          { rotation: -35 }
        )
      ],
      "c"
    );
  });

  it("carries an ancestor's flip as well as its turn", () => {
    expectFramesArtwork(
      [
        frame(
          "f",
          300,
          200,
          400,
          300,
          [rect("c", 40, 30, 60, 60, { rotation: 25 })],
          { rotation: -35, flipX: true }
        )
      ],
      "c"
    );
  });

  it("frames a rotated frame that is itself top level", () => {
    expectFramesArtwork([frame("f", 300, 200, 400, 300, [rect("c", 1, 2, 3, 4)], { rotation: -35 })], "f");
  });

  it("is unchanged for an unrotated tree", () => {
    // The regression guard in the other direction: the overwhelmingly common
    // case must produce exactly what the translation-only origin produced, or
    // every layer on the page moves.
    const elements = [frame("f", 300, 200, 400, 300, [rect("c", 40, 30, 60, 60)])];
    const c = findNode(elements, "c")!;
    const m = worldMatrixOf(doc(elements), c);
    const origin = computeParentOrigin(elements, "c");
    expect(transformPoint(m, { x: c.x, y: c.y })).toEqual({ x: c.x + origin.x, y: c.y + origin.y });
    expectFramesArtwork(elements, "c");
  });

  it("stays the identity for a top-level layer", () => {
    // So an unturned, un-nested layer emits no `transform` attribute at all —
    // the canvas memo comparator is a byte-level whitelist.
    const r = rect("a", 10, 20, 30, 40);
    expect(worldMatrixOf(doc([r]), r)).toEqual(identityMatrix());
  });

  it("answers with an identity for an unknown node rather than throwing", () => {
    expect(computeParentWorldMatrix([rect("a", 0, 0, 1, 1)], "nope")).toEqual(identityMatrix());
  });

  it("differs from the translation-only origin exactly when an ancestor is turned", () => {
    const turned = [frame("f", 300, 200, 400, 300, [rect("c", 40, 30, 60, 60)], { rotation: -35 })];
    const level = [frame("f", 300, 200, 400, 300, [rect("c", 40, 30, 60, 60)])];
    const at = (els: DesignElement[]) =>
      transformPoint(worldMatrixOf(doc(els), findNode(els, "c")!), { x: 40, y: 30 });

    // Unturned: the matrix's translation IS the old origin.
    expect(at(level)).toEqual({ x: 340, y: 230 });
    // Turned: not — which is the whole bug, stated as a number.
    expect(at(turned)).not.toEqual({ x: 340, y: 230 });
  });
});

describe("computeParentWorldMatrix", () => {
  it("is the identity for a top-level node and a pure shift for an unturned one", () => {
    const r = rect("a", 10, 20, 30, 40);
    expect(computeParentWorldMatrix([r], "a")).toEqual(identityMatrix());

    const nested = frame("f", 300, 200, 400, 300, [rect("c", 40, 30, 60, 60)]);
    const m = computeParentWorldMatrix([nested], "c");
    expect({ x: m.e, y: m.f }).toEqual(computeParentOrigin([nested], "c"));
  });

  it("turns with the ancestor instead of only shifting by it", () => {
    const nested = frame("f", 0, 0, 400, 300, [rect("c", 40, 30, 60, 60)], { rotation: 90 });
    const m = computeParentWorldMatrix([nested], "c");
    // A 90° turn maps (dx, dy) → (-dy, dx); a translation cannot.
    const p = transformPoint(m, { x: 40, y: 30 });
    const q = transformPoint(m, { x: 140, y: 30 });
    expect(q.y - p.y).toBeCloseTo(100, 9);
    expect(q.x - p.x).toBeCloseTo(0, 9);
  });
});

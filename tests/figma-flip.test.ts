/**
 * Figma encodes a flip as a negative scale inside `relativeTransform`, and a
 * node has no `flipX` / `flipY` field at all — so an importer that reads only
 * the named fields imports every flipped layer as its unflipped twin, silently.
 *
 * The cases below are the matrix, not a screenshot: each builds the matrix the
 * way Figma writes it and asserts what the importer makes of it. The property
 * that matters most is the one the last group states for lines and the
 * `compose` helper states for everything else — turn the element the way the
 * renderer does and the matrix has to come back, because that is the only thing
 * that keeps a mirror a mirror.
 *
 * `rotation` is Figma's, which counts counter-clockwise: the docs define it as
 * `atan2(-m10, m00)`, the NEGATIVE of the angle the matrix turns through. The
 * fixtures therefore state it as the negation of the angle they built.
 */

import { describe, expect, it } from "vitest";
import { importFigmaFile } from "../src/core/import/figma-import";
import type { FigmaFileResponse } from "../src/core/import/figma-types";
import type { DesignElement } from "../src/core/dsl/types";

/** `R(θ)·S(sx, sy)`, written the way Figma writes `relativeTransform`. */
function figmaTransform(deg: number, sx: number, sy: number, tx = 0, ty = 0): number[][] {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [
    [cos * sx, -sin * sy, tx],
    [sin * sx, cos * sy, ty],
    [0, 0, 1]
  ];
}

/**
 * The matrix the renderer builds from an element: `rotate(rotation)` around the
 * box centre with `scale(flipX, flipY)` inside it — `elementTransform`'s string
 * form, as a matrix. Rounded, because it is compared against Figma's floats.
 */
function compose(el: { rotation?: number; flipX?: boolean; flipY?: boolean }): number[][] {
  const r = ((el.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = el.flipX ? -1 : 1;
  const sy = el.flipY ? -1 : 1;
  return [
    [cos * sx, -sin * sy],
    [sin * sx, cos * sy]
  ];
}

/** The linear part of a Figma transform, in the same round shape. */
const linear = (m: number[][]): number[][] => [
  [m[0][0], m[0][1]],
  [m[1][0], m[1][1]]
];

/** Entry by entry, with a tolerance: `cos 225°` is one ulp off `-cos 45°`. */
function expectSameMatrix(actual: number[][], expected: number[][]): void {
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) expect(actual[row][col]).toBeCloseTo(expected[row][col], 9);
  }
}

const SIZE = { x: 100, y: 50 };

/** Degrees in the range Figma reports, -180..180. */
const signed = (deg: number): number => (((deg % 360) + 540) % 360) - 180;

const elementId = (figmaId: string): string => figmaId.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * One layer as the plugin really exports it: its own `size`, the canvas bound that
 * turn produces, and the `rotation` Figma derives from the same matrix — which is
 * `atan2(-m10, m00)`, the negative of the angle the layer is drawn at. The field is
 * what the importer used to read a mirror out of, so every fixture here states it.
 */
function layer(id: string, name: string, deg: number, sx: number, sy: number, extra: Record<string, unknown> = {}) {
  const r = (deg * Math.PI) / 180;
  const width = Math.abs(SIZE.x * Math.cos(r)) + Math.abs(SIZE.y * Math.sin(r));
  const height = Math.abs(SIZE.x * Math.sin(r)) + Math.abs(SIZE.y * Math.cos(r));
  return {
    id,
    name,
    type: "RECTANGLE",
    absoluteBoundingBox: { x: 0, y: 0, width, height },
    size: { ...SIZE },
    relativeTransform: figmaTransform(deg, sx, sy),
    rotation: signed(-(deg + (sx < 0 ? 180 : 0))),
    fills: [],
    ...extra
  };
}

async function importNodes(children: unknown[]) {
  const file = {
    name: "Flips",
    lastModified: "2024-01-01T00:00:00Z",
    thumbnailUrl: "",
    version: "1",
    role: "owner",
    editorType: "figma",
    linkAccess: "view",
    document: {
      id: "9:9",
      name: "Flips",
      type: "DOCUMENT",
      children: [{ id: "9:10", name: "Page 1", type: "CANVAS", children }]
    }
  } as unknown as FigmaFileResponse;
  const { pages } = await importFigmaFile(file);
  return pages[0].children;
}

const byId = (elements: DesignElement[], id: string): any => {
  let found: any;
  const walk = (list: DesignElement[]): void => {
    for (const el of list) {
      if (el.id === id) found = el;
      const children = (el as { children?: DesignElement[] }).children;
      if (children) walk(children);
    }
  };
  walk(elements);
  return found;
};

describe("a flip, which Figma writes only as a negative scale", () => {
  it("reads the mirror off the determinant, for every shape that can carry one", async () => {
    const nodes = [
      layer("1:1", "None", 0, 1, 1),
      layer("1:2", "H", 0, -1, 1),
      layer("1:3", "V", 0, 1, -1),
      layer("1:4", "Both", 0, -1, -1),
      layer("1:5", "Text", 0, -1, 1, { type: "TEXT", characters: "x", style: { fontSize: 12 } }),
      layer("1:6", "Frame", 0, 1, -1, { type: "FRAME" })
    ];
    const elements = await importNodes(nodes);

    // No mirror, no flip: a plain layer keeps the angle its matrix turns through.
    expect(byId(elements, "1_1")).not.toHaveProperty("flipX");
    expect(byId(elements, "1_1")).not.toHaveProperty("flipY");

    for (const node of nodes.slice(1)) {
      const el = byId(elements, elementId(node.id));
      // The mirror is never lost — which is the whole claim — and it is stated
      // once, on Y: `R(0)·flipX` and `R(180)·flipY` are one matrix, and the second
      // is the one whose `rotation` is the angle the layer is drawn at, which is
      // the angle Figma's own `rotation` field reports.
      expectSameMatrix(compose(el), linear(node.relativeTransform));
      expect(el).not.toHaveProperty("flipX");
    }
    // A frame mirrors its whole subtree, which is what the designer flipped.
    expect(byId(elements, "1_6").flipY).toBe(true);
  });

  it("does not invent a mirror at the angles where a quarter turn is one", async () => {
    // `a = cos θ` is 0 at 90°, and a comparison between the matrix's angle and
    // Figma's `rotation` — which counts the other way — disagrees by a half turn
    // exactly there, which is how a plain 90° rotation used to arrive carrying a
    // phantom flip and a rotation a half turn out of true.
    const nodes = [
      layer("2:1", "90", 90, 1, 1),
      layer("2:2", "90 V", 90, 1, -1),
      layer("2:3", "270 H", 270, -1, 1),
      layer("2:4", "45 H", 45, -1, 1)
    ];
    const elements = await importNodes(nodes);

    expect(byId(elements, "2_1")).not.toHaveProperty("flipX");
    expect(byId(elements, "2_1")).not.toHaveProperty("flipY");
    expect(byId(elements, "2_1").rotation).toBe(90);
    for (const node of nodes) {
      // Every one of the four composes back to the matrix Figma wrote — the
      // mirror on three of them, the quarter turn alone on the first.
      const el = byId(elements, elementId(node.id));
      expectSameMatrix(compose(el), linear(node.relativeTransform));
      expect(el).not.toHaveProperty("flipX");
    }
    for (const id of ["2_2", "2_3", "2_4"]) expect(byId(elements, id).flipY).toBe(true);
  });

  it("carries no flip when the response has no transform, rather than guessing one", async () => {
    const elements = await importNodes([
      { id: "3:1", name: "Bare", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 }, fills: [] }
    ]);
    expect(byId(elements, "3_1")).not.toHaveProperty("flipX");
    expect(byId(elements, "3_1")).not.toHaveProperty("flipY");
  });

  it("gives a line an angle, not a mirror — mirroring a segment returns the same segment", async () => {
    const elements = await importNodes([
      {
        id: "4:1",
        name: "Mirror H",
        type: "LINE",
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
        size: { x: 100, y: 60 },
        relativeTransform: figmaTransform(0, -1, 1, 100, 0),
        strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
        strokeWeight: 2
      },
      {
        id: "4:2",
        name: "Mirror V",
        type: "LINE",
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
        size: { x: 100, y: 60 },
        relativeTransform: figmaTransform(0, 1, -1, 0, 60),
        strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
        strokeWeight: 2
      }
    ]);
    const h = byId(elements, "4_1");
    // `flipX` on a line would paint exactly the same line, so it must not be
    // there; the mirror has to live in the angle. The local box diagonal is 31°
    // below horizontal; mirrored horizontally it points up-left at 149°, which
    // is 118° away from where the local diagonal points.
    expect(h).not.toHaveProperty("flipX");
    expect(h).not.toHaveProperty("flipY");
    expect(h.rotation).toBeCloseTo(118.07, 1);
    // Mirrored vertically it points up-right at -31°, the OTHER diagonal of the
    // same box — which is why the two are not the same answer and the direction
    // has to come from the matrix rather than from a flag. -31° of world angle
    // against a local diagonal at +31° is a -62° turn.
    expect(byId(elements, "4_2").rotation).toBeCloseTo(-61.93, 1);
    // A mirror leaves the box alone: the AABB is the same either way.
    expect(h).toMatchObject({ dx: 100, dy: 60 });
  });

  it("derives a line's angle exactly equal to `rotation` when nothing is flipped", async () => {
    // The property that makes the derivation safe: with no flip it must agree
    // with the field the document already states, or it is a second guess.
    for (const deg of [0, 30, 45, 90, 135, 180, 225, 270, 315, 359]) {
      const elements = await importNodes([
        {
          id: "5:1",
          name: `L${deg}`,
          type: "LINE",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
          size: { x: 100, y: 60 },
          relativeTransform: figmaTransform(deg, 1, 1),
          rotation: deg,
          strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
          strokeWeight: 2
        }
      ]);
      const line = byId(elements, "5_1");
      const expected = ((deg % 360) + 360) % 360;
      const got = line.rotation ?? 0;
      expect(Math.min(Math.abs(got - expected), 360 - Math.abs(got - expected)), `at ${deg}°`).toBeLessThan(0.02);
    }
  });

  it("derives a line's angle from a HORIZONTAL local segment too", async () => {
    // Figma's line is locally a single edge in some encodings and the box
    // diagonal in others; `size.y === 0` is the first case, and the same
    // derivation has to be right for it.
    const elements = await importNodes([
      {
        id: "6:1",
        name: "Flat then flipped",
        type: "LINE",
        absoluteBoundingBox: { x: 0, y: 0, width: 70.71, height: 70.71 },
        size: { x: 100, y: 0 },
        relativeTransform: figmaTransform(45, 1, -1),
        rotation: 45,
        strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
        strokeWeight: 2
      }
    ]);
    // Local (100, 0) at 0°, mirrored vertically to -0°, then turned 45° → 45°.
    expect(byId(elements, "6_1").rotation).toBeCloseTo(45, 2);
  });
});
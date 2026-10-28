import { describe, it, expect } from "vitest";
import { CanvasDefs } from "../src/ui/canvas/CanvasDefs";
import type { DesignElement, PaintStack, Stroke } from "../src/core/dsl/types";

/**
 * Preact matches keyed children by key alone, so two siblings sharing a key are
 * reconciled as one — a def can be dropped, duplicated, or swapped with its
 * neighbour. The fill pass builds gradients, image tiles, pattern tiles and the
 * per-layer colour filters in ONE `fill_defs_<id>` fragment (CanvasDefs), which
 * is exactly where a per-kind key prefix has to keep them apart: an image fill
 * carrying an `adjust` emits both a `<pattern>` and a `<filter>` at the same
 * index, and a bare `key={fIdx}` made those the same child.
 */
function flattenChildren(x: any, out: any[] = []): any[] {
  if (Array.isArray(x)) {
    for (const c of x) flattenChildren(c, out);
    return out;
  }
  if (x === null || x === undefined || x === false || x === true) return out;
  out.push(x);
  return out;
}

/** Every immediate-sibling group in the vnode tree, arrays flattened to one list. */
function siblingGroups(node: any, groups: any[][] = []): any[][] {
  if (Array.isArray(node)) {
    for (const c of node) siblingGroups(c, groups);
    return groups;
  }
  if (!node || typeof node !== "object") return groups;
  const kids = (node.props ?? {}).children;
  if (kids === undefined) return groups;
  const flat = flattenChildren(kids);
  groups.push(flat);
  for (const c of flat) siblingGroups(c, groups);
  return groups;
}

function duplicateKeys(node: any): string[] {
  const dupes: string[] = [];
  for (const group of siblingGroups(node)) {
    const keys = group.map((v) => v?.key).filter((k) => k !== null && k !== undefined);
    const seen = new Set<string>();
    for (const k of keys) {
      const key = String(k);
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
  }
  return dupes;
}

const imageWithAdjust: PaintStack = [
  { type: "image", assetId: "a1", adjust: { invert: 1 } } as any
];
const dots: PaintStack = [
  { type: "pattern", motif: "dots", tile: { width: 16, height: 16 }, foreground: "#000000" } as any
];
const linearGradient: PaintStack = [
  {
    type: "linear",
    stops: [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#ffffff" }
    ],
    start: { x: 0, y: 0 },
    end: { x: 100, y: 0 }
  } as any
];
const strokeWithPattern: Stroke = {
  width: 2,
  color: "#000000",
  paint: { type: "pattern", motif: "dots", tile: { width: 16, height: 16 }, foreground: "#ff0000" } as any
};

const cases: Array<{ name: string; el: DesignElement }> = [
  {
    name: "image fill plus its layer colour filter",
    el: { id: "r1", type: "rect", x: 0, y: 0, width: 100, height: 100, fills: imageWithAdjust }
  },
  {
    name: "image filter, image tile and a pattern tile on one element",
    el: {
      id: "r2",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [...imageWithAdjust, ...dots]
    }
  },
  {
    name: "gradient, pattern and image fills together",
    el: {
      id: "r3",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [...linearGradient, ...dots, ...imageWithAdjust]
    }
  },
  {
    name: "stroke pattern alongside a fill",
    el: {
      id: "r4",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: dots,
      strokes: [strokeWithPattern]
    }
  },
  {
    name: "colour filter plus drop shadow",
    el: {
      id: "r5",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: imageWithAdjust,
      adjust: { invert: 1 },
      effects: [{ type: "drop-shadow", color: "#000000", blur: 4, offset: { x: 0, y: 4 } }] as any
    }
  }
];

const assets = [{ id: "a1", uri: "data:image/png;base64,AAAA" }] as any;

describe("defs sibling keys", () => {
  for (const { name, el } of cases) {
    it(`has no duplicate key among siblings: ${name}`, () => {
      const tree = CanvasDefs({ allElements: [el], selectedIds: new Set(), assets } as any);
      expect(duplicateKeys(tree)).toEqual([]);
    });
  }
});

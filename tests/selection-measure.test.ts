import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";
import { computeMeasurement } from "../src/core/geometry/measure-guides";
import { selectionCommonParent, selectionWorldBox } from "../src/ui/hooks/canvas-gestures/selection-measure";

/**
 * The Alt read-out measures the selection as ONE object: a multi-selection's
 * distances leave from the union box the chrome frames, and its padding is
 * measured against the frame that actually holds all of it.
 */

const docOf = (elements: DesignElement[], canvas = { width: 1440, height: 4000 }): DesignDocument =>
  normalizeDesignDocument({ version: "0.1", canvas, elements }).document;

const rect = (id: string, x: number, y: number, width: number, height: number, extra = {}): DesignElement =>
  ({ id, type: "rect", name: id, x, y, width, height, ...extra }) as DesignElement;

const frame = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  children: DesignElement[]
): DesignElement => ({ id, type: "frame", name: id, x, y, width, height, children }) as DesignElement;

const ids = (...list: string[]) => new Set(list);

describe("selectionWorldBox", () => {
  it("unions every member's own box, not just the first", () => {
    const doc = docOf([rect("a", 0, 0, 100, 50), rect("b", 200, 100, 50, 50)]);
    expect(selectionWorldBox(doc, ids("a", "b"), null)).toEqual({ x: 0, y: 0, width: 250, height: 150 });
  });

  it("carries a nested member through its ancestors' translation", () => {
    const doc = docOf([frame("card", 500, 800, 360, 200, [rect("inner", 24, 32, 120, 20)])]);
    expect(selectionWorldBox(doc, ids("inner"), null)).toEqual({ x: 524, y: 832, width: 120, height: 20 });
  });

  it("measures a turned member by the envelope it paints", () => {
    const doc = docOf([rect("turned", 0, 0, 100, 50, { rotation: 90 })]);
    // 90° about its own centre swaps the sides: 50×100 centred on (50, 25).
    expect(selectionWorldBox(doc, ids("turned"), null)).toEqual({ x: 25, y: -25, width: 50, height: 100 });
  });

  it("ignores an id with no box to measure", () => {
    const doc = docOf([rect("a", 0, 0, 10, 10)]);
    expect(selectionWorldBox(doc, ids("ghost"), null)).toBeNull();
  });
});

describe("selectionCommonParent", () => {
  it("answers the shared parent of siblings", () => {
    const doc = docOf([frame("f", 0, 0, 400, 300, [rect("a", 10, 10, 20, 20), rect("b", 100, 10, 20, 20)])]);
    expect(selectionCommonParent(getActivePage(doc).children, ids("a", "b"))?.id).toBe("f");
  });

  it("climbs to the common container when the members sit in different frames", () => {
    const doc = docOf([
      frame("outer", 0, 0, 800, 600, [
        frame("left", 10, 10, 200, 200, [rect("a", 10, 10, 20, 20)]),
        frame("right", 300, 10, 200, 200, [rect("b", 10, 10, 20, 20)])
      ])
    ]);
    expect(selectionCommonParent(getActivePage(doc).children, ids("a", "b"))?.id).toBe("outer");
  });

  it("treats a selected ancestor as part of the object, not as its frame", () => {
    const doc = docOf([frame("outer", 0, 0, 800, 600, [frame("inner", 10, 10, 200, 200, [rect("a", 10, 10, 20, 20)])])]);
    expect(selectionCommonParent(getActivePage(doc).children, ids("inner", "a"))?.id).toBe("outer");
  });

  it("answers nothing when a member sits at the top level", () => {
    const doc = docOf([frame("f", 0, 0, 400, 300, [rect("a", 10, 10, 20, 20)]), rect("loose", 500, 0, 20, 20)]);
    expect(selectionCommonParent(getActivePage(doc).children, ids("a", "loose"))).toBeNull();
  });
});

describe("the Alt read-out on a multi-selection", () => {
  const doc = docOf([
    frame("f", 0, 0, 400, 300, [rect("a", 20, 20, 100, 40), rect("b", 160, 20, 100, 40)])
  ]);

  it("leaves from the union of the members, not from the first one", () => {
    const ref = selectionWorldBox(doc, ids("a", "b"), null)!;
    expect(ref).toEqual({ x: 20, y: 20, width: 240, height: 40 });

    // The layer to the right is 20 from the pair's right edge (260). Measured
    // from "a" alone the same gap would read 160, which is the bug this covers.
    const beside = computeMeasurement(ref, { x: 280, y: 20, width: 100, height: 40 });
    expect(beside.lines).toHaveLength(1);
    expect(beside.lines[0].distance).toBe(20);
  });

  it("keeps the padding of the frame that holds the pair", () => {
    const ref = selectionWorldBox(doc, ids("a", "b"), null)!;
    const pad = computeMeasurement(ref, { x: 0, y: 0, width: 400, height: 300 }, true);
    expect(pad.lines.map((l) => l.distance).sort((x, y) => x - y)).toEqual([20, 20, 140, 240]);
  });
});

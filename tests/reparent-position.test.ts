import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { DesignElement, FrameElement, RectElement } from "../src/core/dsl/types";
import { applyLayerDrop } from "../src/ui/layers/layer-reorder";
import {
  childrenOf,
  computeParentOrigin,
  findElementById,
  findParentById,
  reparentOnCanvasDrop
} from "../src/core/geometry/tree-ops";

// `x` / `y` are parent-LOCAL, so a move that changes the parent moves the layer on
// the canvas without anyone writing a coordinate. Every reparent path therefore
// has to re-express the numbers in the space they land in — `reparentOnCanvasDrop`
// has always done it; the layer panel's drop did not, and a row dragged from one
// frame into another jumped by the difference between the two frames' origins.
//
// "Stays put" means the layer's canvas position: its local `x` read against the
// origin of the space it is written in, which is what `computeParentOrigin` answers
// for whichever space the layer is stored in. That is the number the user watches.

const rect = (id: string, x = 0, y = 0): RectElement => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width: 40,
  height: 20
});

const frame = (id: string, x: number, y: number, children: DesignElement[] = []): FrameElement => ({
  id,
  type: "frame",
  name: id,
  x,
  y,
  width: 200,
  height: 200,
  children
});

/** A horizontal stack at `x`, holding three 80-wide rows. */
const stack = (x: number, children: DesignElement[] = []): FrameElement => ({
  ...frame("stack", x, 0, children),
  ...flattenLayout({ mode: "flex", direction: "row", gap: 20, padding: 10, justify: "start", align: "start" })
});

/** Two free frames, the first holding one rect at its own local origin. */
const twoFrames = (): DesignElement[] => [frame("a", 100, 100, [rect("kid", 10, 20)]), frame("b", 500, 40)];

/** Where a layer paints: its `x` read in the space it is stored in. */
function canvasPosition(elements: DesignElement[], id: string): { x: number; y: number } {
  const el = findElementById(elements, id);
  if (!el) throw new Error(`no ${id}`);
  const origin = computeParentOrigin(elements, id);
  return { x: origin.x + el.x, y: origin.y + el.y };
}

function dropped(result: ReturnType<typeof applyLayerDrop>): DesignElement[] {
  if (!("elements" in result)) throw new Error(`drop was refused: ${result.refused}`);
  return result.elements;
}

function parentIdOf(elements: DesignElement[], id: string): string | null {
  return findParentById(elements, id)?.id ?? null;
}

describe("a layer panel drop keeps the layer where it paints", () => {
  it("into another free frame", () => {
    const elements = twoFrames();
    const before = canvasPosition(elements, "kid");

    const moved = dropped(applyLayerDrop(elements, ["kid"], "b", "inside"));

    expect(parentIdOf(moved, "kid")).toBe("b");
    expect(canvasPosition(moved, "kid")).toEqual(before);
    // The conversion is a real write: `b` is 400 to the right of `a`, so the
    // local number has to come back with that difference folded in.
    expect(findElementById(moved, "kid")!.x).toBe(before.x - 500);
  });

  it("out to the page", () => {
    const elements = twoFrames();
    const before = canvasPosition(elements, "kid");

    // Beside a top-level row, so the landing parent is the page itself.
    const moved = dropped(applyLayerDrop(elements, ["kid"], "a", "after"));

    expect(parentIdOf(moved, "kid")).toBeNull();
    expect(canvasPosition(moved, "kid")).toEqual(before);
    expect(findElementById(moved, "kid")!.x).toBe(before.x);
  });

  it("beside a row of a different frame, where the landing parent is that row's", () => {
    const elements: DesignElement[] = [
      frame("a", 100, 100, [rect("kid", 10, 20)]),
      frame("b", 500, 40, [rect("other", 30, 5)])
    ];
    const before = canvasPosition(elements, "kid");

    const moved = dropped(applyLayerDrop(elements, ["kid"], "other", "after"));

    expect(parentIdOf(moved, "kid")).toBe("b");
    expect(canvasPosition(moved, "kid")).toEqual(before);
  });

  it("for every row of a multi-selection", () => {
    const elements: DesignElement[] = [
      frame("a", 100, 100, [rect("one", 10, 20), rect("two", 70, 90)]),
      frame("b", 500, 40)
    ];
    const before = [canvasPosition(elements, "one"), canvasPosition(elements, "two")];

    const moved = dropped(applyLayerDrop(elements, ["one", "two"], "b", "inside"));

    expect(canvasPosition(moved, "one")).toEqual(before[0]);
    expect(canvasPosition(moved, "two")).toEqual(before[1]);
  });

  it("and a reorder among siblings is left exactly where it was", () => {
    const elements: DesignElement[] = [
      frame("a", 100, 100, [rect("one", 10, 20), rect("two", 70, 90)])
    ];
    const before = canvasPosition(elements, "two");

    const moved = dropped(applyLayerDrop(elements, ["two"], "one", "before"));

    expect(childrenOf(findElementById(moved, "a")!).map((c) => c.id)).toEqual(["two", "one"]);
    expect(canvasPosition(moved, "two")).toEqual(before);
  });

  it("gives the same answer as the canvas drop, which has always converted", () => {
    // Overlapping frames, so a rect far enough inside `a` has its centre inside
    // `b` — which is what the canvas drop hit-tests.
    const elements: DesignElement[] = [
      frame("a", 100, 100, [rect("kid", 140, 40)]),
      frame("b", 250, 100)
    ];
    const before = canvasPosition(elements, "kid");

    const onCanvas = reparentOnCanvasDrop(elements, "kid");
    expect(onCanvas.reparented).toBe(true);
    expect(parentIdOf(onCanvas.elements, "kid")).toBe("b");

    const inPanel = dropped(applyLayerDrop(elements, ["kid"], "b", "inside"));

    expect(findElementById(inPanel, "kid")).toEqual(findElementById(onCanvas.elements, "kid"));
    expect(canvasPosition(inPanel, "kid")).toEqual(before);
  });

  it("but hands the layer to the destination's flow when the destination is a stack", () => {
    // A flex parent places its in-flow children itself, so the slot is the answer
    // and the canvas position is deliberately not preserved — Figma's behaviour,
    // and what the canvas drop does too.
    const elements: DesignElement[] = [stack(200, [rect("s1", 0, 0), rect("s2", 0, 0)]), rect("loose", 0, 0)];

    const moved = dropped(applyLayerDrop(elements, ["loose"], "stack", "inside"));

    // padding 10 + two 40-wide rows + two 20 gaps.
    expect(findElementById(moved, "loose")!.x).toBe(130);
    expect(canvasPosition(moved, "loose")).toEqual({ x: 330, y: 10 });
  });
});

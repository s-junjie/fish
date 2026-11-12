import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMultiResizeGesture } from "../src/ui/hooks/canvas-gestures/multi-resize-gesture";
import { DesignDocument, DesignElement, RectElement } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/document-ops";
import { GuideLine } from "../src/core/geometry/snap-guides";

/**
 * The multi-selection's corner drag, driven through its own pointer handlers.
 *
 * `resolveResizeBox` (the single-layer path) states the invariant these cases
 * grade as `aspectActive`: "Snapping and the ratio constraint are mutually
 * exclusive". The union was re-implementing the ratio lock beside a snap that ran
 * unconditionally, so a corner drag under Shift — or under the Scale tool, which
 * locks the corner too — snapped its width and left the height the ratio had been
 * derived from. One axis moved, the other did not, and the group came back
 * squashed by however far the guide pulled.
 */

const CANVAS = {
  width: 2000,
  height: 2000,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#FFFFFF" }
};

const rect = (id: string, x: number, y: number, width: number, height: number): RectElement => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  width,
  height,
  fills: [{ type: "solid", color: "#000000" }]
});

const docOf = (elements: DesignElement[]): DesignDocument =>
  ({
    version: "0.1",
    id: "doc",
    name: "doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas: CANVAS,
    pages: [{ id: "p1", name: "P1", canvas: CANVAS, children: elements }],
    activePageId: "p1"
  }) as DesignDocument;

let listeners: Record<string, (e: any) => void> = {};
let frames: Array<() => void> = [];

beforeEach(() => {
  listeners = {};
  frames = [];
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: any) => void) => {
      listeners[type] = fn;
    },
    removeEventListener: (type: string) => {
      delete listeners[type];
    }
  });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const drain = () => {
  const queued = frames;
  frames = [];
  for (const fn of queued) fn();
};

const down = () => ({ button: 0, clientX: 100, clientY: 100, stopPropagation() {}, preventDefault() {} });

/**
 * A union of two 100×60 rects: 300 wide, 60 tall, 5:1. A stray mark sits 2px past
 * the right edge and 2px past the bottom edge the drag will land on, inside the
 * 6px magnet — anything that snaps will be pulled off the ratio.
 */
function harness(options: { scaleMode?: boolean; hiddenMark?: boolean } = {}) {
  const mark = options.hiddenMark
    ? { ...rect("mark", 702, 222, 10, 10), visible: false as const }
    : rect("mark", 702, 222, 10, 10);
  const holder = { current: docOf([rect("a", 100, 100, 100, 60), rect("b", 300, 100, 100, 60), mark]) };
  let guides: GuideLine[] = [];
  const gesture = createMultiResizeGesture({
    docRef: holder,
    setDoc: (updater) => {
      holder.current = updater(holder.current);
    },
    pan: { x: 0, y: 0 },
    zoom: 1,
    startDragGesture: () => {},
    endDragGesture: () => {},
    scaleMode: options.scaleMode,
    setActiveGuides: (next) => {
      guides = next;
    },
    currentContainerRect: () => null
  });
  return { holder, gesture, guides: () => guides };
}

const drag = (h: ReturnType<typeof harness>, dx: number, shiftKey: boolean) => {
  h.gesture.handleMultiResizePointerDown(down() as any, "br", new Set(["a", "b"]));
  listeners.pointermove({ clientX: 100 + dx, clientY: 100, shiftKey, altKey: false });
  drain();
  listeners.pointerup({});
  drain();
};

const boxes = (h: ReturnType<typeof harness>) =>
  getActivePage(h.holder.current).children.map((el) => [el.width, el.height]);

describe("a multi-selection corner drag", () => {
  it("keeps the union's ratio under Shift by not snapping at all", () => {
    const h = harness();
    drag(h, 300, true);
    // 300×60 doubled is 600×120: both axes, exactly, with a guide 2px away that
    // would have pulled the width alone to 602.
    expect(boxes(h)).toEqual([[200, 120], [200, 120], [10, 10]]);
    expect(h.guides(), "a ratio-locked drag has nothing to snap").toEqual([]);
  });

  it("does the same when the Scale tool is the thing holding the corner", () => {
    const h = harness({ scaleMode: true });
    drag(h, 300, false);
    expect(boxes(h)).toEqual([[200, 120], [200, 120], [10, 10]]);
    expect(h.guides()).toEqual([]);
  });

  it("still snaps a free corner, where there is no ratio to protect", () => {
    // The control: without Shift and without the tool, the drag is a plain resize
    // of the union and the magnet is expected to work.
    const h = harness();
    drag(h, 300, false);
    // 600 wide from the pointer, pulled to 602 by the guide — and the height is
    // left exactly where a free resize leaves it.
    expect(boxes(h)[0]).toEqual([200.67, 60]);
    expect(h.guides()).not.toEqual([]);
  });

  it("reads its magnets from the shared candidate list, so a hidden layer is not one", () => {
    // Same stray mark, one difference: it is hidden, so the canvas never painted
    // it and there is nothing to align to. The old walk listed the flat page and
    // took whatever it found — hidden layers, deep children of unrelated frames —
    // and pulled the drag onto geometry the user cannot see.
    const h = harness({ hiddenMark: true });
    drag(h, 300, false);
    expect(boxes(h)[0]).toEqual([200, 60]);
    expect(h.guides()).toEqual([]);
  });
});

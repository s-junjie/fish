import { describe, expect, it } from "vitest";
import { createDragApply } from "../src/ui/hooks/canvas-gestures/drag-apply";
import { DesignDocument, DesignElement, FrameElement } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/document-ops";

/**
 * The drop-target probe of a MULTI-selection drag.
 *
 * The snap box of a multi-drag is the selection's union, so the point the frame
 * search asks about is the union's CENTRE — which can sit inside one of the
 * layers being dragged. Only the primary was excluded from that search, so a
 * second frame in the selection lit up as the container the group was about to
 * be dropped into, over a drop that would land on it (and be refused).
 */

const CANVAS = {
  width: 2000,
  height: 2000,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#FFFFFF" }
};

const frame = (id: string, x: number, y: number, width: number, height: number): FrameElement =>
  ({ id, type: "frame", name: id, x, y, width, height, children: [] }) as FrameElement;

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

/**
 * A at x 0–100 and B at x 400–600, both selected: the union is 0–600, so its
 * centre starts at x=300 and a +150 drag puts it at x=450 — inside B's box.
 */
function harness() {
  const docRef = { current: docOf([frame("a", 0, 0, 100, 100), frame("b", 400, 0, 200, 200)]) };
  const over: Array<string | null> = [];
  const apply = createDragApply({
    docRef,
    setDoc: (updater) => {
      docRef.current = updater(docRef.current);
    },
    zoom: 1,
    pan: { x: 0, y: 0 },
    currentContainerRect: () => null,
    setActiveGuides: () => {},
    setDragOverFrameId: (id) => over.push(id),
    setDropSlot: () => {},
    setSelectedIds: () => {},
    duplicateUndoRef: { current: null },
    dragStartElements: {
      current: new Map<string, { x: number; y: number; startOffset?: number }>([
        ["a", { x: 0, y: 0 }],
        ["b", { x: 400, y: 0 }]
      ])
    },
    dragSelectionRef: { current: new Set(["a", "b"]) },
    dragSnapExcludeRef: { current: new Set() },
    snapCacheRef: { current: null },
    dragPrimary: { current: { id: "a", box: { x: 0, y: 0, width: 600, height: 200 } } },
    dragStartMouse: { current: { x: 0, y: 0 } },
    hasMovedBeyondThreshold: { current: true },
    dropSlotRef: { current: null },
    dropSlotParentRef: { current: null }
  });
  return { docRef, apply, over };
}

describe("a multi-selection drag", () => {
  it("does not offer a frame the group is already dragging as a drop target", () => {
    const h = harness();
    h.apply.applyDragFrame(150, 0, false, false);

    expect(h.over.at(-1)).toBeNull();
    // The drag really did apply, so the line above is not the verdict of a
    // gesture that never ran.
    expect(getActivePage(h.docRef.current).children.map((el) => el.x)).toEqual([150, 550]);
  });

  it("still offers a frame that is NOT part of the drag", () => {
    // The control: the same probe with only A selected must find B, which is
    // what makes the exclusion above about the extra ids rather than about the
    // search never returning anything.
    const docRef = { current: docOf([frame("a", 0, 0, 100, 100), frame("b", 400, 0, 200, 200)]) };
    const over: Array<string | null> = [];
    const apply = createDragApply({
      docRef,
      setDoc: (updater) => {
        docRef.current = updater(docRef.current);
      },
      zoom: 1,
      pan: { x: 0, y: 0 },
      currentContainerRect: () => null,
      setActiveGuides: () => {},
      setDragOverFrameId: (id) => over.push(id),
      setDropSlot: () => {},
      setSelectedIds: () => {},
      duplicateUndoRef: { current: null },
      dragStartElements: {
        current: new Map<string, { x: number; y: number; startOffset?: number }>([["a", { x: 0, y: 0 }]])
      },
      dragSelectionRef: { current: new Set(["a"]) },
      dragSnapExcludeRef: { current: new Set() },
      snapCacheRef: { current: null },
      dragPrimary: { current: { id: "a", box: { x: 0, y: 0, width: 100, height: 100 } } },
      dragStartMouse: { current: { x: 0, y: 0 } },
      hasMovedBeyondThreshold: { current: true },
      dropSlotRef: { current: null },
      dropSlotParentRef: { current: null }
    });
    // A alone is 0–100, so its centre lands at 450 after a +400 drag.
    apply.applyDragFrame(400, 0, false, false);
    expect(over.at(-1)).toBe("b");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGradientGesture } from "../src/ui/hooks/canvas-gestures/gradient-gesture";
import { DesignDocument, DesignElement, getActivePage } from "../src/core/dsl/types";

/**
 * What a CANCELLED pointer leaves behind.
 *
 * The lever writes `document.body.style.cursor = "grabbing"` at pointerdown and
 * puts it back at pointerup; the knob that draws the grip listens for both
 * `pointerup` and `pointercancel`, so it releases its own pressed state either
 * way. The gesture did not — a cancelled pointer (window blur, a trackpad
 * gesture, the browser reclaiming the pointer) restored neither the cursor nor
 * the undo entry the press had opened.
 */

const CANVAS = {
  width: 2000,
  height: 2000,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#FFFFFF" }
};

const gradientRect = (): DesignElement =>
  ({
    id: "r",
    type: "rect",
    name: "r",
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    fills: [
      {
        type: "linear-gradient",
        angle: 90,
        stops: [
          { offset: 0, color: "#000000" },
          { offset: 1, color: "#FFFFFF" }
        ]
      }
    ]
  }) as DesignElement;

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

beforeEach(() => {
  listeners = {};
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: any) => void) => {
      listeners[type] = fn;
    },
    removeEventListener: (type: string) => {
      delete listeners[type];
    }
  });
  vi.stubGlobal("document", { body: { style: { cursor: "" } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function harness() {
  const el = gradientRect();
  const docRef = { current: docOf([el]) };
  const startDragGesture = vi.fn();
  const endDragGesture = vi.fn();
  const gesture = createGradientGesture({
    docRef,
    setDoc: (updater) => {
      docRef.current = updater(docRef.current);
    },
    pan: { x: 0, y: 0 },
    zoom: 1,
    canvasContainerRef: {
      current: {
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
      } as unknown as HTMLDivElement
    },
    startDragGesture,
    endDragGesture,
    setHintMessage: () => {},
    currentContainerRect: () => null,
    setActiveGuides: () => {}
  });
  return { el, docRef, gesture, startDragGesture, endDragGesture };
}

const press = () =>
  ({
    button: 0,
    clientX: 300,
    clientY: 150,
    stopPropagation() {},
    preventDefault() {}
  }) as unknown as PointerEvent;

describe("the gradient lever's pointer", () => {
  it("puts the body cursor back when the pointer is CANCELLED", () => {
    const h = harness();
    h.gesture.handleGradientHandlePointerDown(press(), h.el, 0, "start");
    expect(document.body.style.cursor).toBe("grabbing");
    expect(h.startDragGesture).toHaveBeenCalled();

    listeners.pointercancel({});

    expect(document.body.style.cursor).toBe("");
    expect(h.endDragGesture).toHaveBeenCalledTimes(1);
    // The gesture is over: no listener may outlive it.
    expect(Object.keys(listeners)).toEqual([]);
  });

  it("does the same for a stop drag", () => {
    const h = harness();
    h.gesture.handleGradientStopPointerDown(press(), h.el, 0, 0);
    expect(document.body.style.cursor).toBe("grabbing");

    listeners.pointercancel({});

    expect(document.body.style.cursor).toBe("");
    expect(h.endDragGesture).toHaveBeenCalledTimes(1);
    expect(Object.keys(listeners)).toEqual([]);
  });

  it("restores the cursor a successful release, and only once", () => {
    const h = harness();
    h.gesture.handleGradientHandlePointerDown(press(), h.el, 0, "start");
    listeners.pointerup({});
    expect(document.body.style.cursor).toBe("");
    expect(h.endDragGesture).toHaveBeenCalledTimes(1);
    expect(getActivePage(h.docRef.current).children[0].fills?.length).toBe(1);
  });
});

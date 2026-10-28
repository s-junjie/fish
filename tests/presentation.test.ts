import { describe, it, expect } from "vitest";
import { presentationFrames, nextSlideOf, PAGE_FRAME_ID, findPresentationSlideIndex } from "../src/core/presentation/frames";
import { isBrowserReservedKey } from "../src/ui/present/presentKeys";
import { fitRect } from "../src/core/geometry/fit";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

function doc(elements: DesignElement[]): DesignDocument {
  const canvas = { width: 1000, height: 1000, unit: "px" as const, background: { type: "solid" as const, color: "#FFFFFF" } };
  return {
    // Derived, not typed in: a fixture that hardcodes the dialect claims to be
    // current and goes quietly stale the day the dialect moves.
    version: LATEST_DOCUMENT_VERSION,
    id: "test",
    name: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
    activePageId: "page_1",
    elements
  };
}

const frame = (id: string, x: number, y: number, w: number, h: number, extra = {}): DesignElement =>
  ({ id, type: "frame", name: id, x, y, width: w, height: h, children: [], ...extra }) as DesignElement;

const rect = (id: string, x: number, y: number, w: number, h: number, extra = {}): DesignElement =>
  ({ id, type: "rect", name: id, x, y, width: w, height: h, ...extra }) as DesignElement;

const ids = (d: DesignDocument) => presentationFrames(d).map((f) => f.id);

describe("presentationFrames", () => {
  it("orders slides the way the canvas is laid out, not the way they are stored", () => {
    // Two rows, and the array deliberately in neither reading order nor the
    // panel's. A deck that walked `elements[]`, or `elements[]` reversed, gets
    // this wrong in a different direction each time — which is the point.
    const deck = doc([
      frame("top-right", 600, 0, 400, 300),
      frame("bottom-left", 0, 400, 400, 300),
      frame("top-left", 0, 0, 400, 300),
      frame("bottom-right", 600, 400, 400, 300)
    ]);
    expect(ids(deck)).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);
  });

  it("ignores how far apart two boards in one row are", () => {
    // Hand-placed artboards are never aligned to the pixel. Sorting on `y` alone
    // reorders the deck over a 6px difference.
    const deck = doc([frame("right", 900, 6, 400, 300), frame("left", 0, 0, 400, 300)]);
    expect(ids(deck)).toEqual(["left", "right"]);
  });

  it("keeps boards of wildly different heights in the row they visually share", () => {
    // A 40px strip beside a 1200px board: any fixed pixel tolerance would put
    // these in different rows, and so would comparing the two tops.
    const deck = doc([frame("tower", 600, 0, 400, 1200), frame("strip", 0, 100, 400, 40)]);
    expect(ids(deck)).toEqual(["strip", "tower"]);
  });

  it("splits rows that barely overlap", () => {
    // 100px boards overlapping by exactly half their height are two rows, not
    // one: half the shorter is the boundary, and both readings of it are
    // arbitrary — what matters is that the answer is the same every time.
    const deck = doc([frame("a", 0, 0, 400, 100), frame("b", 600, 50, 400, 100)]);
    expect(ids(deck)).toEqual(["a", "b"]);
  });

  it("leaves a hidden artboard out of the deck", () => {
    expect(ids(doc([frame("a", 0, 0, 100, 100), frame("hidden", 200, 0, 100, 100, { visible: false })]))).toEqual(["a"]);
  });

  it("leaves a zero-area artboard out of the deck", () => {
    // A 0-width frame is a legal stored value, and as a slide it fits to 1:1 and
    // shows an empty screen with the counter still counting it.
    expect(
      ids(doc([frame("flat", 0, 0, 0, 100), frame("dot", 0, 0, 1, 0), frame("real", 0, 0, 100, 100)]))
    ).toEqual(["real"]);
  });

  it("treats a top-level component as a slide", () => {
    const component = { id: "c", type: "component", name: "c", x: 0, y: 0, width: 80, height: 80, children: [] };
    expect(ids(doc([component as DesignElement]))).toEqual(["c"]);
  });

  it("does not confuse a nested artboard for a slide", () => {
    const outer = frame("outer", 0, 0, 400, 400);
    (outer as any).children = [frame("inner", 10, 10, 100, 100)];
    expect(ids(doc([outer]))).toEqual(["outer"]);
  });

  it("presents a page with no artboards as one slide of its own", () => {
    const frames = presentationFrames(doc([rect("r", 0, 0, 100, 50), rect("r2", 200, 100, 100, 50)]));
    expect(frames.map((f) => f.id)).toEqual([PAGE_FRAME_ID]);
    expect(frames[0].bounds).toEqual({ x: 0, y: 0, width: 300, height: 150 });
  });

  it("has no slides on an empty page", () => {
    expect(presentationFrames(doc([]))).toEqual([]);
  });

  it("fits the artboard's own box, not the union of what it holds", () => {
    // A slide is the frame you see; a child painted outside an unclipped frame
    // is not part of the slide.
    const f = frame("f", 100, 200, 300, 150);
    (f as any).children = [rect("escapee", 900, 900, 50, 50)];
    expect(presentationFrames(doc([f]))[0].bounds).toEqual({ x: 100, y: 200, width: 300, height: 150 });
  });
});

describe("nextSlideOf", () => {
  it("reads the next frame in deck order, not array order, and stops at the last", () => {
    const deck = doc([
      frame("right", 600, 0, 400, 300),
      frame("left", 0, 0, 400, 300),
      frame("below", 0, 400, 400, 300)
    ]);
    const frames = presentationFrames(deck);
    expect(nextSlideOf(frames, "left")?.id).toBe("right");
    expect(nextSlideOf(frames, "right")?.id).toBe("below");
    expect(nextSlideOf(frames, "below")).toBeNull();
    expect(nextSlideOf(frames, "missing")).toBeNull();
  });
});

import { calculatePresentFit } from "../src/ui/present/presentScale";

describe("fitRect", () => {
  const area = { x: 0, y: 0, width: 1000, height: 500 };

  it("centres the bounds and takes the tighter axis", () => {
    const fit = fitRect({ x: 0, y: 0, width: 400, height: 400 }, area, { margin: 0 })!;
    expect(fit.zoom).toBeCloseTo(1.25);
    expect(fit.pan.x).toBeCloseTo(500 - 200 * 1.25);
    expect(fit.pan.y).toBeCloseTo(250 - 200 * 1.25);
  });

  it("leaves the margin on both sides", () => {
    const fit = fitRect({ x: 0, y: 0, width: 1000, height: 1000 }, area, { margin: 50 })!;
    expect(fit.zoom).toBeCloseTo(0.4);
  });

  it("honours an offset area, which is what a panel-dodging viewport has", () => {
    const fit = fitRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 240, y: 0, width: 760, height: 500 }, { margin: 0 })!;
    expect(fit.pan.x).toBeCloseTo(240 + 380 - 50 * 5);
  });

  it("sits at 1:1 on the area's middle when there is nothing to frame", () => {
    expect(fitRect(null, area)).toEqual({ zoom: 1, pan: { x: 500, y: 250 } });
  });

  it("has no answer when the area has no extent", () => {
    expect(fitRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
  });

  it("clamps to the ceiling, which is what keeps a 10px frame off a 4000x screen", () => {
    expect(fitRect({ x: 0, y: 0, width: 10, height: 10 }, area, { margin: 0, maxZoom: 5 })!.zoom).toBe(5);
    expect(fitRect({ x: 0, y: 0, width: 10, height: 10 }, area, { margin: 0, maxZoom: 40 })!.zoom).toBe(40);
  });

  it("falls back to 1:1 rather than handing a NaN to scale()", () => {
    // A NaN zoom is `scale(NaN)`: nothing paints and nothing throws.
    const fit = fitRect({ x: 0, y: 0, width: 0, height: 0 }, area, { margin: 0, minZoom: 0 })!;
    expect(Number.isFinite(fit.zoom)).toBe(true);
  });
});

describe("isBrowserReservedKey", () => {
  const key = (init: Partial<KeyboardEvent> & { key: string }) => init as KeyboardEvent;

  it("lets the browser's own chords through", () => {
    for (const code of ["KeyW", "KeyT", "KeyQ", "KeyM", "KeyN"]) {
      expect(isBrowserReservedKey(key({ key: "x", code, metaKey: true }))).toBe(true);
      expect(isBrowserReservedKey(key({ key: "x", code, ctrlKey: true }))).toBe(true);
    }
    expect(isBrowserReservedKey(key({ key: "F5" }))).toBe(true);
    expect(isBrowserReservedKey(key({ key: "F12" }))).toBe(true);
  });

  it("reserves nothing an editor shortcut is built from", () => {
    // ⌥Arrow nudged the layer behind the overlay and pushed an undo entry,
    // because the arrow branch reads `e.key` and never looks at the modifiers.
    // ⌘R opened a rename field back there that the deck then ate keystrokes of.
    expect(isBrowserReservedKey(key({ key: "ArrowLeft", altKey: true }))).toBe(false);
    expect(isBrowserReservedKey(key({ key: "ArrowUp", altKey: true }))).toBe(false);
    expect(isBrowserReservedKey(key({ key: "r", code: "KeyR", metaKey: true }))).toBe(false);
    expect(isBrowserReservedKey(key({ key: "d", code: "KeyD", metaKey: true }))).toBe(false);
    expect(isBrowserReservedKey(key({ key: "z", code: "KeyZ", metaKey: true }))).toBe(false);
    expect(isBrowserReservedKey(key({ key: "Backspace" }))).toBe(false);
  });

  it("does not let a chord through just because Alt rewrote the character", () => {
    // macOS applies Option to the CHARACTER: ⌥⌘C arrives as "ç". Matching on the
    // character is how a reserved chord gets disguised as an editor one.
    expect(isBrowserReservedKey(key({ key: "ç", code: "KeyC", metaKey: true, altKey: true }))).toBe(false);
  });
});

describe("calculatePresentFit", () => {
  const viewport = { width: 1000, height: 500 };
  const bounds = { x: 100, y: 50, width: 400, height: 200 };

  it("calculates 100% actual size", () => {
    const fit = calculatePresentFit(bounds, viewport, "actual")!;
    expect(fit.zoom).toBe(1);
    expect(fit.pan.x).toBe((1000 - 400) / 2 - 100);
    expect(fit.pan.y).toBe((500 - 200) / 2 - 50);
  });

  it("calculates responsive mode capped at 100% when artboard is smaller than screen", () => {
    const fit = calculatePresentFit(bounds, viewport, "responsive")!;
    expect(fit.zoom).toBe(1); // doesn't upscale beyond 100%
  });

  it("calculates responsive mode scaling down when artboard is larger than screen", () => {
    const bigBounds = { x: 0, y: 0, width: 2000, height: 1000 };
    const fit = calculatePresentFit(bigBounds, viewport, "responsive")!;
    expect(fit.zoom).toBe(0.5);
  });

  it("calculates fit-width mode", () => {
    const fit = calculatePresentFit(bounds, viewport, "fit-width")!;
    expect(fit.zoom).toBe(2.5); // 1000 / 400
  });

  it("calculates fit width and height mode (scaling up or down)", () => {
    const fit = calculatePresentFit(bounds, viewport, "fit")!;
    expect(fit.zoom).toBe(2.5); // min(1000/400=2.5, 500/200=2.5)
  });

  it("calculates fill mode (cover)", () => {
    const tallBounds = { x: 0, y: 0, width: 200, height: 200 };
    const fit = calculatePresentFit(tallBounds, viewport, "fill")!;
    expect(fit.zoom).toBe(5); // max(1000/200=5, 500/200=2.5)
  });

  it("aligns to the top when content height exceeds viewport height", () => {
    // A long webpage frame: width fits viewport, height exceeds viewport
    const tallBounds = { x: 0, y: 10, width: 1000, height: 2000 };
    const fit = calculatePresentFit(tallBounds, viewport, "actual")!;
    expect(fit.zoom).toBe(1);
    expect(fit.pan.x).toBe(0);
    // panY aligns to top (-by * zoom = -10) rather than centering
    expect(fit.pan.y).toBe(-10);
  });

  it("returns null for invalid bounds or viewport", () => {
    expect(calculatePresentFit(null, viewport, "actual")).toBeNull();
    expect(calculatePresentFit({ x: 0, y: 0, width: 0, height: 100 }, viewport, "actual")).toBeNull();
    expect(calculatePresentFit(bounds, { width: 0, height: 500 }, "actual")).toBeNull();
  });
});

describe("findPresentationSlideIndex", () => {
  it("defaults to 0 when no element is selected", () => {
    const deck = doc([frame("f1", 0, 0, 400, 300), frame("f2", 500, 0, 400, 300)]);
    const frames = presentationFrames(deck);
    expect(findPresentationSlideIndex(frames, deck, null)).toBe(0);
  });

  it("starts on the slide when a top-level frame itself is selected", () => {
    const deck = doc([frame("f1", 0, 0, 400, 300), frame("f2", 500, 0, 400, 300)]);
    const frames = presentationFrames(deck);
    expect(findPresentationSlideIndex(frames, deck, "f2")).toBe(1);
  });

  it("starts on the containing slide when any child inside a top-level frame is selected", () => {
    const child = rect("child_inside_f2", 10, 10, 50, 50);
    const f2 = frame("f2", 500, 0, 400, 300, { children: [child] });
    const deck = doc([frame("f1", 0, 0, 400, 300), f2]);
    const frames = presentationFrames(deck);
    expect(findPresentationSlideIndex(frames, deck, "child_inside_f2")).toBe(1);
  });

  it("starts on the containing slide when a deeply nested element is selected", () => {
    const deepChild = rect("deep_leaf", 5, 5, 20, 20);
    const innerFrame = frame("inner", 10, 10, 100, 100, { children: [deepChild] });
    const f3 = frame("f3", 1000, 0, 400, 300, { children: [innerFrame] });
    const deck = doc([frame("f1", 0, 0, 400, 300), frame("f2", 500, 0, 400, 300), f3]);
    const frames = presentationFrames(deck);
    expect(findPresentationSlideIndex(frames, deck, "deep_leaf")).toBe(2);
  });

  it("falls back to 0 when an unknown id is selected", () => {
    const deck = doc([frame("f1", 0, 0, 400, 300), frame("f2", 500, 0, 400, 300)]);
    const frames = presentationFrames(deck);
    expect(findPresentationSlideIndex(frames, deck, "unknown_id")).toBe(0);
  });
});


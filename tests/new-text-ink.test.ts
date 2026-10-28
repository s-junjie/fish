import { describe, it, expect } from "vitest";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/types";
import { inkForBackground, newTextInkAt } from "../src/core/geometry/ink-on";
import { contrastRatio, relativeLuminance } from "../src/core/geometry/color-utils";
import { computeShapeDraftBounds } from "../src/core/geometry/shape-creation";
import { commitCreatedShape } from "../src/ui/hooks/canvas-gestures/shape-creation";
import { createPasteMedia } from "../src/ui/hooks/paste-media";
import { flattenElements } from "../src/core/geometry/tree-edit";

const DARK_PAGE = "#101010";
const LIGHT_PAGE = "#E8E7E3";

function docWith(children: DesignElement[], background = DARK_PAGE): DesignDocument {
  const canvas = {
    width: 1200,
    height: 800,
    unit: "px" as const,
    background: { type: "solid" as const, color: background }
  };
  return {
    docId: "d",
    id: "d",
    version: 1,
    name: "t",
    createdAt: "",
    updatedAt: "",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children }],
    activePageId: "page_1"
  } as unknown as DesignDocument;
}

function rect(id: string, x: number, y: number, w: number, h: number, fill: string, extra: object = {}): DesignElement {
  return {
    id,
    type: "rect",
    name: id,
    x,
    y,
    width: w,
    height: h,
    fills: [{ type: "solid", color: fill }],
    ...extra
  } as DesignElement;
}

describe("contrast maths", () => {
  it("reads the two ends of the scale", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });
});

describe("inkForBackground", () => {
  it("puts white on a dark page and black on a light one", () => {
    expect(inkForBackground(DARK_PAGE)).toBe("#FFFFFF");
    expect(inkForBackground(LIGHT_PAGE)).toBe("#000000");
  });

  it("answers mid-grey with the ink that measures better, not with a threshold", () => {
    // #808080: black is 5.32:1, white 3.95:1.
    expect(contrastRatio("#808080", "#000000")).toBeGreaterThan(contrastRatio("#808080", "#FFFFFF"));
    expect(inkForBackground("#808080")).toBe("#000000");
  });
});

describe("newTextInkAt", () => {
  it("uses the page background when nothing covers the point", () => {
    expect(newTextInkAt(docWith([]), { x: 10, y: 10 })).toBe("#FFFFFF");
    expect(newTextInkAt(docWith([], LIGHT_PAGE), { x: 10, y: 10 })).toBe("#000000");
  });

  it("reads a frame the text is about to land in", () => {
    const frame = {
      id: "f",
      type: "frame",
      name: "f",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      children: [],
      fills: [{ type: "solid", color: "#FFFFFF" }]
    } as unknown as DesignElement;
    expect(newTextInkAt(docWith([frame]), { x: 200, y: 150 })).toBe("#000000");
  });

  it("lets a child paint over its container's fill", () => {
    const frame = {
      id: "f",
      type: "frame",
      name: "f",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      children: [rect("card", 0, 0, 400, 300, "#111111")],
      fills: [{ type: "solid", color: "#FFFFFF" }]
    } as unknown as DesignElement;
    expect(newTextInkAt(docWith([frame]), { x: 200, y: 150 })).toBe("#FFFFFF");
  });

  it("takes the top-most of two overlapping shapes", () => {
    const elements = [rect("under", 0, 0, 400, 300, "#FFFFFF"), rect("over", 100, 100, 100, 100, "#000000")];
    expect(newTextInkAt(docWith(elements), { x: 150, y: 150 })).toBe("#FFFFFF");
    expect(newTextInkAt(docWith(elements), { x: 20, y: 20 })).toBe("#000000");
  });

  it("skips a translucent fill rather than guessing at the blend", () => {
    const elements = [rect("base", 0, 0, 400, 300, "#FFFFFF"), rect("veil", 0, 0, 400, 300, "#00000080")];
    expect(newTextInkAt(docWith(elements), { x: 200, y: 150 })).toBe("#000000");
  });

  it("skips a gradient fill and answers from what is behind it", () => {
    const gradient = {
      id: "g",
      type: "rect",
      name: "g",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      fills: [
        {
          type: "gradient",
          gradientType: "linear",
          stops: [
            { color: "#000000", offset: 0 },
            { color: "#FFFFFF", offset: 1 }
          ]
        }
      ]
    } as unknown as DesignElement;
    expect(newTextInkAt(docWith([gradient], LIGHT_PAGE), { x: 200, y: 150 })).toBe("#000000");
  });

  it("ignores a hidden layer", () => {
    const elements = [rect("gone", 0, 0, 400, 300, "#FFFFFF", { visible: false })];
    expect(newTextInkAt(docWith(elements), { x: 200, y: 150 })).toBe("#FFFFFF");
  });

  it("follows a turned container to where it actually paints", () => {
    const frame = {
      id: "f",
      type: "frame",
      name: "f",
      x: 0,
      y: 0,
      width: 400,
      height: 100,
      rotation: 90,
      children: [],
      fills: [{ type: "solid", color: "#FFFFFF" }]
    } as unknown as DesignElement;
    // Turned about its centre (200, 50) the 400×100 box covers x 150–250,
    // y -150–250 — so (200, 200) is inside the painted box and outside the
    // stored one.
    expect(newTextInkAt(docWith([frame]), { x: 200, y: 200 })).toBe("#000000");
    expect(newTextInkAt(docWith([frame]), { x: 380, y: 50 })).toBe("#FFFFFF");
  });
});

describe("the text tool", () => {
  function drawText(doc: DesignDocument) {
    let committed: DesignDocument | null = null;
    commitCreatedShape({
      finalGeom: computeShapeDraftBounds("text", { x: 100, y: 100 }, { x: 340, y: 160 }, {
        shiftKey: false,
        altKey: false
      }),
      dist: 70,
      docRef: { current: doc },
      commitSnapshot: (next) => {
        committed = next;
      },
      setSelectedIds: () => {},
      setActiveTool: () => {},
      startCanvasTextEdit: () => {}
    });
    return getActivePage(committed as unknown as DesignDocument).children.find((el) => el.type === "text") as
      | DesignElement
      | undefined;
  }

  it("writes the backdrop's ink into both stores the DSL reads", () => {
    const onDark = drawText(docWith([]));
    expect(onDark?.fills).toEqual([{ type: "solid", color: "#FFFFFF" }]);
    expect((onDark as any).style.color).toBe("#FFFFFF");

    const onLight = drawText(docWith([], LIGHT_PAGE));
    expect(onLight?.fills).toEqual([{ type: "solid", color: "#000000" }]);
  });
});

describe("pasted text", () => {
  it("reads the backdrop in canvas space, not in the drop target's parent space", () => {
    const inner = {
      id: "inner",
      type: "frame",
      name: "inner",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [],
      fills: [{ type: "solid", color: "#FFFFFF" }]
    } as unknown as DesignElement;
    const outer = {
      id: "outer",
      type: "frame",
      name: "outer",
      x: 100,
      y: 100,
      width: 200,
      height: 200,
      children: [inner],
      fills: [{ type: "solid", color: DARK_PAGE }]
    } as unknown as DesignElement;

    const doc = docWith([outer]);
    let committed: DesignDocument | null = null;
    const paste = createPasteMedia({
      docRef: { current: doc },
      selectedIds: new Set(["inner"]),
      setSelectedIds: () => {},
      commitSnapshot: (next) => {
        committed = next;
      },
      setHintMessage: () => {},
      viewportRect: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      lastPngCopyRef: { current: null }
    });
    paste.pastePlainText("hello");

    const text = flattenElements(getActivePage(committed as unknown as DesignDocument).children).find(
      (el) => el.type === "text"
    ) as DesignElement;
    // Centred in `inner`, whose parent sits at (100, 100) — the frame's white,
    // not the dark page the un-offset point would have read.
    expect(text.fills).toEqual([{ type: "solid", color: "#000000" }]);
  });
});

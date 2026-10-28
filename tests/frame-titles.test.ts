import { describe, it, expect } from "vitest";
import { resolveFrameTitles } from "../src/ui/canvas/frame-titles";
import { FrameTitleOverlay } from "../src/ui/canvas/FrameTitleOverlay";
import { renderNodeList } from "../src/ui/canvas/SvgElementRenderer";
import { NodeRenderContext } from "../src/ui/canvas/NodeRenderContext";
import { DesignElement } from "../src/core/dsl/types";

// `measureText` has no DOM here, so it falls back to the analytic estimate:
// 0.6em per glyph, i.e. 6.6px at the label's 11px. Every budget below is
// floor(screenWidth / 6.6).
const el = (
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  name?: string
): DesignElement => ({ id, type, name, x, y, width, height, children: [] } as unknown as DesignElement);

const frame = (id: string, name: string, width = 240, height = 300) =>
  el(id, "frame", 0, 0, width, height, name);

const nameOf = (e: DesignElement) => e.name || "";

describe("a frame name never grows past the frame", () => {
  it("says the whole name when it fits", () => {
    const titles = resolveFrameTitles([frame("a", "Home")], 1, nameOf);
    expect(titles.get("a")).toBe("Home");
  });

  it("truncates with an ellipsis to the frame's width on screen", () => {
    // 240px of frame at 0.5 is 120px of screen, so 18 glyphs fit.
    const titles = resolveFrameTitles([frame("a", "1 Title: App Splash Screen")], 0.5, nameOf);
    expect(titles.get("a")).toBe("1 Title: App Spla…");
    expect(titles.get("a")!.length).toBe(18);
  });

  it("truncates further as the zoom falls", () => {
    const titles = resolveFrameTitles([frame("a", "1 Title: App Splash Screen")], 0.2, nameOf);
    expect(titles.get("a")).toBe("1 Titl…");
  });

  it("drops a frame too narrow to say anything", () => {
    // One glyph of room is not a name.
    expect(resolveFrameTitles([frame("a", "Home", 10)], 0.5, nameOf).size).toBe(0);
  });

  it("charges a component's diamond to the frame's width, not to the label's", () => {
    const component = el("c", "component", 0, 0, 240, 300, "1 Title: App Splash Screen");
    const asFrame = frame("c", "1 Title: App Splash Screen");
    const withMark = resolveFrameTitles([component], 0.5, nameOf).get("c")!;
    const without = resolveFrameTitles([asFrame], 0.5, nameOf).get("c")!;
    expect(withMark.length).toBe(without.length - 2);
  });

  it("leaves room for an instance's typed prefix", () => {
    const instance = el("i", "instance", 0, 0, 240, 300, "1 Title: App Splash Screen");
    expect(resolveFrameTitles([instance], 0.5, nameOf).get("i")!.length).toBe(16);
  });
});

describe("a canvas too far out carries no names at all", () => {
  it("is silent below 5% zoom, however wide the frame", () => {
    expect(resolveFrameTitles([frame("a", "Home", 4000)], 0.04, nameOf).size).toBe(0);
  });

  it("still names a wide frame at exactly 5%", () => {
    expect(resolveFrameTitles([frame("a", "Home Page", 4000)], 0.05, nameOf).get("a")).toBe(
      "Home Page"
    );
  });
});

describe("what never gets a name", () => {
  it("is a leaf shape, a hidden frame, or a mask stencil", () => {
    const rect = el("r", "rect", 0, 0, 400, 400, "Rect");
    const hidden = { ...frame("h", "Hidden"), visible: false } as DesignElement;
    const mask = { ...frame("m", "Mask"), isMask: true } as DesignElement;
    expect(resolveFrameTitles([rect, hidden, mask], 1, nameOf).size).toBe(0);
  });
});

describe("a name is chrome, not part of the artwork", () => {
  const ctx = (): NodeRenderContext => ({
    selectedIds: new Set<string>(),
    setSelectedIds: () => {},
    docRef: {
      current: {
        version: "0.1",
        name: "test",
        canvas: { width: 1000, height: 1000 },
        pages: [],
        activePageId: ""
      } as any
    },
    zoom: 1,
    rasterScale: 1,
    activeTool: "select",
    worldBounds: new Map(),
    dragOverFrameId: null,
    editingCanvasTextId: null,
    canvasTextDraft: "",
    setCanvasTextDraft: () => {},
    canvasTextInputRef: { current: null },
    onElementMouseDown: () => {},
    onStartCanvasTextEdit: () => {},
    onCommitCanvasText: () => {},
    onCancelCanvasText: () => {}
  });

  it("paints the label as a layer outside the frame's filter", () => {
    const shadowed = {
      ...frame("a", "Home"),
      effects: [{ type: "drop-shadow", color: "#000", offset: { x: 0, y: 4 }, blur: 8, enabled: true }]
    } as DesignElement;
    const nodes = renderNodeList([shadowed], ctx(), true);
    const overlay = nodes.find((n) => (n as any).type === FrameTitleOverlay) as any;
    expect(overlay).toBeTruthy();
    expect(overlay.props.titles.get("a")).toBe("Home");
  });
});

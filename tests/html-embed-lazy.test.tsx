import { describe, expect, it } from "vitest";
import { SvgHtmlEmbedNode } from "../src/ui/canvas/SvgHtmlEmbedNode";
import { HtmlEmbedElement } from "../src/core/dsl/types";
import { NodeRenderContext } from "../src/ui/canvas/NodeRenderContext";

function makeContext(overrides: Partial<NodeRenderContext> = {}): NodeRenderContext {
  return {
    selectedIds: new Set<string>(),
    setSelectedIds: () => {},
    docRef: { current: { version: "0.1", name: "test", canvas: { width: 1000, height: 1000 }, pages: [], activePageId: "" } as any },
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
    onCancelCanvasText: () => {},
    frameTitles: true,
    ...overrides
  };
}

/** Flatten all VNodes in the tree */
function elementsIn(vnode: any, out: any[] = []): any[] {
  if (vnode == null || typeof vnode !== "object") return out;
  if (typeof vnode.type === "string") out.push(vnode);
  const children = vnode.props?.children;
  for (const c of Array.isArray(children) ? children : [children]) {
    elementsIn(c, out);
  }
  return out;
}

const byTag = (vnode: any, tag: string): any[] => elementsIn(vnode).filter((v) => v.type === tag);

describe("SvgHtmlEmbedNode lazy loading and poster gating", () => {
  const baseElement: HtmlEmbedElement = {
    id: "html_1",
    type: "html",
    name: "Interactive Demo",
    x: 100,
    y: 100,
    width: 600,
    height: 400,
    srcdoc: "<!doctype html><html><body><canvas></canvas></body></html>"
  };

  it("does NOT mount an iframe in resting unselected mode", () => {
    const ctx = makeContext({ frameTitles: true });
    const vnode = SvgHtmlEmbedNode({
      el: baseElement,
      shapeLocalD: "M0,0 H600 V400 H0 Z",
      ctx,
      onDoubleClick: () => {}
    });

    const iframes = byTag(vnode, "iframe");
    expect(iframes).toHaveLength(0);

    // Renders the fallback placeholder card
    const rects = byTag(vnode, "rect");
    expect(rects.length).toBeGreaterThan(0);

    // Hit overlay path is rendered for drag & selection
    const hitPaths = byTag(vnode, "path").filter((p) => p.props["data-hit"] === "true");
    expect(hitPaths).toHaveLength(1);
  });

  it("renders <image> poster when posterAssetId is provided and resolves", () => {
    const elementWithPoster: HtmlEmbedElement = {
      ...baseElement,
      posterAssetId: "asset_poster_1"
    };
    const ctx = makeContext({ frameTitles: true });
    const resolveAssetUri = (id: string) => (id === "asset_poster_1" ? "data:image/webp;base64,abc123" : undefined);

    const vnode = SvgHtmlEmbedNode({
      el: elementWithPoster,
      shapeLocalD: "M0,0 H600 V400 H0 Z",
      resolveAssetUri,
      ctx,
      onDoubleClick: () => {}
    });

    const iframes = byTag(vnode, "iframe");
    expect(iframes).toHaveLength(0);

    const images = byTag(vnode, "image");
    expect(images).toHaveLength(1);
    expect(images[0].props.href).toBe("data:image/webp;base64,abc123");
  });

  it("mounts a live iframe in Presentation Mode (frameTitles === false)", () => {
    const ctx = makeContext({ frameTitles: false });
    const vnode = SvgHtmlEmbedNode({
      el: baseElement,
      shapeLocalD: "M0,0 H600 V400 H0 Z",
      ctx,
      onDoubleClick: () => {}
    });

    const iframes = byTag(vnode, "iframe");
    expect(iframes).toHaveLength(1);
    expect(iframes[0].props["data-html-embed-id"]).toBe("html_1");

    // In presentation mode, hit overlay is absent so page can be scrolled
    const hitPaths = byTag(vnode, "path").filter((p) => p.props["data-hit"] === "true");
    expect(hitPaths).toHaveLength(0);
  });

  it("mounts the live preview as soon as the embed is selected, and keeps the pointer on the canvas", () => {
    const ctx = makeContext({ frameTitles: true, selectedIds: new Set<string>(["html_1"]) });
    const vnode = SvgHtmlEmbedNode({
      el: baseElement,
      shapeLocalD: "M0,0 H600 V400 H0 Z",
      ctx,
      onDoubleClick: () => {}
    });

    const iframes = byTag(vnode, "iframe");
    expect(iframes).toHaveLength(1);
    expect(iframes[0].props["data-html-embed-id"]).toBe("html_1");

    // The preview does NOT take the pointer, so the hit overlay is still there
    // and the layer can be dragged and re-selected while its content shows.
    const host = byTag(vnode, "foreignObject")[0];
    expect(host.props.style.pointerEvents).toBe("none");
    const hitPaths = byTag(vnode, "path").filter((p) => p.props["data-hit"] === "true");
    expect(hitPaths).toHaveLength(1);

    // No exit affordance: a canvas preview has no interactive mode to leave.
    const labels = byTag(vnode, "text").map((n) => n.props.children);
    expect(labels).not.toContain("Esc to exit");
  });
});

describe("SvgHtmlEmbedNode alwaysLive opt-out", () => {
  const baseElement: HtmlEmbedElement = {
    id: "html_1",
    type: "html",
    name: "Live Clock",
    x: 0,
    y: 0,
    width: 600,
    height: 400,
    srcdoc: "<!doctype html><html><body><canvas></canvas></body></html>",
    alwaysLive: true
  };

  const render = (el: HtmlEmbedElement, ctx: NodeRenderContext, resolveAssetUri?: (id: string) => string) =>
    SvgHtmlEmbedNode({
      el,
      shapeLocalD: "M0,0 H600 V400 H0 Z",
      resolveAssetUri,
      ctx,
      onDoubleClick: () => {}
    });

  it("mounts the frame at rest, with nothing selected", () => {
    const vnode = render(baseElement, makeContext({ frameTitles: true, selectedIds: new Set<string>() }));

    expect(byTag(vnode, "iframe")).toHaveLength(1);
    expect(byTag(vnode, "image")).toHaveLength(0);
  });

  /**
   * The reason the flag is a separate state from "selected" rather than a
   * promotion to present mode: a frame that hit-tests swallows the press that
   * starts a drag, so a permanently-live embed would be a layer pinned to the
   * canvas. It is content that follows the layer, not a page you are inside.
   */
  it("keeps the pointer on the canvas, so the layer is still draggable", () => {
    const vnode = render(baseElement, makeContext({ frameTitles: true, selectedIds: new Set<string>() }));

    expect(byTag(vnode, "foreignObject")[0].props.style.pointerEvents).toBe("none");
    expect(byTag(vnode, "path").filter((p) => p.props["data-hit"] === "true")).toHaveLength(1);
  });

  it("prefers the live frame over a poster the layer already captured", () => {
    const withPoster: HtmlEmbedElement = { ...baseElement, posterAssetId: "asset_poster_1" };
    const vnode = render(withPoster, makeContext({ frameTitles: true }), () => "data:image/webp;base64,abc123");

    expect(byTag(vnode, "iframe")).toHaveLength(1);
    expect(byTag(vnode, "image")).toHaveLength(0);
  });

  it("leaves an unflagged embed resting, poster and all", () => {
    const resting: HtmlEmbedElement = { ...baseElement, alwaysLive: undefined, posterAssetId: "asset_poster_1" };
    const vnode = render(resting, makeContext({ frameTitles: true }), () => "data:image/webp;base64,abc123");

    expect(byTag(vnode, "iframe")).toHaveLength(0);
    expect(byTag(vnode, "image")).toHaveLength(1);
  });
});

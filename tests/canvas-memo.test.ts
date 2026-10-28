import { describe, it, expect } from "vitest";
import { SvgNodeProps, MemoizedSvgNode } from "../src/ui/canvas/SvgElementRenderer";
import { RectElement, DesignDocument, FrameElement, InstanceElement } from "../src/core/dsl/types";

describe("Canvas SvgNode Memoization Comparator", () => {
  const dummyDoc: DesignDocument = {
    version: "0.2",
    id: "doc_1",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canvas: { width: 800, height: 600, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
    pages: [],
    activePageId: "p1"
  };

  const el1: RectElement = {
    id: "rect_1",
    name: "Rectangle 1",
    type: "rect",
    x: 10,
    y: 10,
    width: 100,
    height: 50
  };

  const baseProps: SvgNodeProps = {
    el: el1,
    isSelected: false,
    isDragOver: false,
    isEditingText: false,
    isEditingPath: false,
    isMaskStencil: false,
    ctx: {
      selectedIds: new Set(),
      setSelectedIds: () => {},
      docRef: { current: dummyDoc },
      zoom: 1,
      rasterScale: 1,
      activeTool: "select",
      viewportBox: { x: -200, y: -200, width: 1200, height: 1000 },
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
    }
  };

  it("skips re-render (shouldComponentUpdate returns false) when props are unchanged", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    // Next props with identical element reference and same state
    const nextProps: SvgNodeProps = {
      ...baseProps,
      ctx: { ...baseProps.ctx }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(false);
  });

  it("skips re-render when viewportBox is a newly instantiated object with identical values", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    // A fresh object reference with identical values — must NOT bust memo
    const nextProps: SvgNodeProps = {
      ...baseProps,
      ctx: {
        ...baseProps.ctx,
        viewportBox: { x: -200, y: -200, width: 1200, height: 1000 }
      }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(false);
  });

  // The cull moved OUT of the memoized node and into `renderNodeList`, which is
  // not memoized — so the mounted set stays correct without the comparator
  // knowing about the viewport at all. Comparing it here is what cost a wheel
  // tick 51 ms on a 3120-element page: the whole visible tree was rebuilt and
  // re-diffed, and for every node outside the ring at the viewport edge it
  // produced byte-identical markup. If this test ever wants to fail again, the
  // cull has to move back inside the node.
  it("skips re-render even when viewportBox values change", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    const nextProps: SvgNodeProps = {
      ...baseProps,
      ctx: {
        ...baseProps.ctx,
        viewportBox: { x: -300, y: -200, width: 1200, height: 1000 }
      }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(false);
  });

  it("triggers re-render when element object reference changes", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    const nextProps: SvgNodeProps = {
      ...baseProps,
      el: { ...el1, width: 120 }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(true);
  });

  it("triggers re-render when selection state changes", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    const nextProps: SvgNodeProps = {
      ...baseProps,
      isSelected: true
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(true);
  });

  // Zoom is not in this comparator's whitelist, and that is the whole point of
  // the change: every value that holds a constant number of SCREEN pixels (the
  // 8px hit slop, the 11px frame label, the component mark, a set's dashed
  // border) is CSS against `--fish-zoom`, which CanvasArea writes once per tick
  // on the root <svg>. So a zoom tick produces byte-identical markup and the
  // visible tree is served from memory — measured 1,849 DOM writes per tick
  // before, 2 after.
  //
  // If this ever wants to fail again, the bug is a node reading `ctx.zoom`, not
  // the comparator: adding `zoom` back here would "fix" the frozen chrome and
  // put the 52 ms frame back with it.
  it("skips re-render on a zoom change, because no node reads zoom", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    const nextProps: SvgNodeProps = {
      ...baseProps,
      ctx: { ...baseProps.ctx, zoom: 0.06 }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(false);
  });

  // `rasterScale` IS compared: a Liquid Glass bitmap and a conic fan are built
  // for the scale they will be shown at, and `deviceScale` is quantised, so this
  // fires on a rung boundary rather than every tick.
  it("triggers re-render when the raster scale rung changes", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    const nextProps: SvgNodeProps = {
      ...baseProps,
      ctx: { ...baseProps.ctx, rasterScale: 6 }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(true);
  });

  it("triggers re-render when activeTool changes so element event handlers refresh", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    const nextProps: SvgNodeProps = {
      ...baseProps,
      ctx: { ...baseProps.ctx, activeTool: "rect" }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(true);
  });

  // The in-place text editor belongs to a DESCENDANT, so a frame's own
  // `isEditingText` is false before and after the editor closes on its child.
  // Without this comparison the whole subtree is served from memory and the
  // editor stays mounted — Escape left the caret on the canvas.
  it("triggers re-render when the edited text id changes, even for an ancestor frame", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    const nextProps: SvgNodeProps = {
      ...baseProps,
      ctx: { ...baseProps.ctx, editingCanvasTextId: "text_1" }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(true);
  });

  // A selection change is no longer a whole-tree invalidation. A node's own
  // state arrives as `isSelected`, which is compared above; a container is told
  // only when a changed id lives inside it. Comparing `ctx.selectedIds` for every
  // node made a mousedown on one layer re-render all 1,841 nodes on Page 1.
  it("skips a leaf whose subtree does not contain the changed id", () => {
    const memoComponent = new (MemoizedSvgNode as any)(baseProps);
    const nextProps: SvgNodeProps = {
      ...baseProps,
      ctx: {
        ...baseProps.ctx,
        selectedIds: new Set(["other"]),
        selectionChangedIds: new Set(["other"])
      }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(false);
  });

  it("re-renders an ancestor of a changed id, so the new selection reaches its child", () => {
    const frame: FrameElement = {
      id: "frame_1",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [el1]
    };
    const frameProps: SvgNodeProps = { ...baseProps, el: frame };
    const memoComponent = new (MemoizedSvgNode as any)(frameProps);
    const nextProps: SvgNodeProps = {
      ...frameProps,
      ctx: {
        ...frameProps.ctx,
        selectedIds: new Set(["rect_1"]),
        selectionChangedIds: new Set(["rect_1"])
      }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(true);
  });

  it("re-renders an instance that owns a changed derived id", () => {
    const instance: InstanceElement = {
      id: "inst_1",
      type: "instance",
      componentId: "master",
      x: 0,
      y: 0,
      width: 100,
      height: 100
    };
    const instanceProps: SvgNodeProps = { ...baseProps, el: instance };
    const memoComponent = new (MemoizedSvgNode as any)(instanceProps);
    const nextProps: SvgNodeProps = {
      ...instanceProps,
      ctx: {
        ...instanceProps.ctx,
        selectedIds: new Set(["inst_1_child"]),
        selectionChangedIds: new Set(["inst_1_child"])
      }
    };
    expect(memoComponent.shouldComponentUpdate(nextProps)).toBe(true);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { h, render, options } from "preact";
import { useState, useRef, useEffect } from "preact/hooks";
import { EditorStore } from "../src/core/store/editor-store";
import { DesignDocument, RectElement, getActivePage } from "../src/core/dsl/types";
import { useVectorPathEditing } from "../src/ui/hooks/useVectorPathEditing";
import { parsePathData, moveAnchor } from "../src/core/geometry/path-data";
import { useCanvasGestures } from "../src/ui/hooks/useCanvasGestures";

const makeDocWithRect = (borderRadius = 16): DesignDocument => ({
  version: "0.1",
  id: "test_doc",
  name: "Test Doc",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  canvas: { width: 1000, height: 1000, background: { type: "solid", color: "#141414" }, unit: "px" },
  pages: [
    {
      id: "page_1",
      name: "Page 1",
      canvas: { width: 1000, height: 1000, background: { type: "solid", color: "#141414" }, unit: "px" },
      children: [
        {
          id: "rect_1",
          type: "rect",
          x: 20,
          y: 20,
          width: 100,
          height: 80,
          borderRadius
        } as RectElement
      ]
    }
  ],
  activePageId: "page_1",
  elements: [
    {
      id: "rect_1",
      type: "rect",
      x: 20,
      y: 20,
      width: 100,
      height: 80,
      borderRadius
    } as RectElement
  ]
});

function makeNode(type: number, tag: string) {
  const children: any[] = [];
  return {
    nodeType: type,
    nodeName: tag,
    childNodes: children,
    parentNode: null as any,
    appendChild(c: any) {
      c.parentNode = this;
      children.push(c);
      return c;
    },
    removeChild(c: any) {
      const i = children.indexOf(c);
      if (i !== -1) children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    insertBefore(c: any, ref: any) {
      c.parentNode = this;
      const i = children.indexOf(ref);
      if (i !== -1) children.splice(i, 0, c);
      else children.push(c);
      return c;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    style: {}
  };
}

let origDebounce: any;
let origDocument: any;
let origWindow: any;

beforeAll(() => {
  origDebounce = options.debounceRendering;
  options.debounceRendering = (cb) => cb();
  origDocument = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tag: string) => makeNode(1, tag),
    createElementNS: (_: string, tag: string) => makeNode(1, tag),
    createTextNode: (text: string) => {
      const n: any = makeNode(3, "#text");
      n.nodeValue = text;
      return n;
    },
    body: makeNode(1, "BODY")
  };
  origWindow = (globalThis as any).window;
  (globalThis as any).window = new EventTarget();
});

afterAll(() => {
  options.debounceRendering = origDebounce;
  if (origDocument !== undefined) {
    (globalThis as any).document = origDocument;
  } else {
    delete (globalThis as any).document;
  }
  if (origWindow !== undefined) {
    (globalThis as any).window = origWindow;
  } else {
    delete (globalThis as any).window;
  }
});

function setupHarness(initialDoc: DesignDocument) {
  const store = new EditorStore(initialDoc);
  let hookApi: any = null;
  let gesturesApi: any = null;

  let updatePan: (p: { x: number; y: number }) => void = () => {};

  function Harness() {
    const [, setTick] = useState(0);
    useEffect(() => store.subscribe(() => setTick((t) => t + 1)), []);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    updatePan = setPan;
    const docRef = useRef(store.getDoc());
    docRef.current = store.getDoc();
    const [selectedIds, setSelectedIds] = useState(new Set(["rect_1"]));
    hookApi = useVectorPathEditing({
      store,
      docRef,
      commitSnapshot: (d) => store.commit(d),
      selectedIds,
      setSelectedIds
    });
    gesturesApi = useCanvasGestures({
      docRef,
      setDoc: (updater: any) => store.commit(typeof updater === "function" ? updater(store.getDoc()) : updater),
      selectedIds,
      setSelectedIds,
      primarySelected: null,
      activeTool: "select",
      setActiveTool: () => {},
      zoom: 1,
      pan,
      isPanMode: false,
      isPanModeRef: { current: false },
      startCanvasPan: () => {},
      updateCanvasPan: () => false,
      endCanvasPan: () => {},
      canvasContainerRef: {
        current: {
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 })
        } as any
      },
      startDragGesture: () => {},
      endDragGesture: () => {},
      commitSnapshot: (d) => store.commit(d),
      setHintMessage: () => {},
      startCanvasTextEdit: () => {},
      editingPathId: hookApi.editingPathId,
      onAnchorMarquee: hookApi.handleAnchorMarquee
    });
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  render(h(Harness, null), container);

  return {
    store,
    setPan: (p: { x: number; y: number }) => updatePan(p),
    getApi: () => hookApi,
    getGestures: () => gesturesApi,
    cleanup: () => {
      render(null, container);
      container.remove();
    }
  };
}

describe("useVectorPathEditing - Non-destructive vector editing", () => {
  it("restores original rect with borderRadius when exiting vector edit without modification", () => {
    const harness = setupHarness(makeDocWithRect(16));

    const origRect = getActivePage(harness.store.getDoc()).children[0] as RectElement;
    expect(origRect.type).toBe("rect");
    expect(origRect.borderRadius).toBe(16);

    const pastCountBefore = harness.store.canUndo();

    // Enter vector edit
    harness.getApi().startPathEdit(origRect);
    expect(harness.getApi().editingPathId).toBe("rect_1");

    // During edit, transiently converted to path so anchor overlay can function
    const duringEditEl = getActivePage(harness.store.getDoc()).children[0];
    expect(duringEditEl.type).toBe("path");

    // Exit vector edit without modifying any anchors
    harness.getApi().exitPathEdit();
    expect(harness.getApi().editingPathId).toBeNull();

    // Shape is cleanly restored as rect with original borderRadius intact
    const afterExitEl = getActivePage(harness.store.getDoc()).children[0] as RectElement;
    expect(afterExitEl.type).toBe("rect");
    expect(afterExitEl.borderRadius).toBe(16);
    expect(afterExitEl.width).toBe(100);
    expect(afterExitEl.height).toBe(80);

    // No dirty history entry added
    expect(harness.store.canUndo()).toBe(pastCountBefore);

    harness.cleanup();
  });

  it("permanently converts to path when path is modified during edit", () => {
    const harness = setupHarness(makeDocWithRect(16));

    const origRect = getActivePage(harness.store.getDoc()).children[0] as RectElement;
    harness.getApi().startPathEdit(origRect);

    // Modify the path
    const modifiedD = "M 0 0 L 120 0 L 100 80 L 0 80 Z";
    harness.getApi().commitPathEdit(modifiedD);

    // Exit vector edit
    harness.getApi().exitPathEdit();

    // Shape is permanently committed as path
    const afterExitEl = getActivePage(harness.store.getDoc()).children[0];
    expect(afterExitEl.type).toBe("path");
    expect(harness.store.canUndo()).toBe(true);

    harness.cleanup();
  });

  it("handles marquee selection of anchors including shift-add, alt-subtract, and click-clear", () => {
    // Rect without border radius has 4 straight corner anchors
    const harness = setupHarness(makeDocWithRect(0));
    const origRect = getActivePage(harness.store.getDoc()).children[0] as RectElement;
    harness.getApi().startPathEdit(origRect);

    // Initial state: selectedAnchorIdxs is empty
    expect(harness.getApi().selectedAnchorIdxs.size).toBe(0);

    // 1. Marquee box enclosing top two anchors (idx 0 at (20,20), idx 1 at (120,20))
    // minX: 10, minY: 10, maxX: 130, maxY: 30
    harness.getApi().handleAnchorMarquee(
      { minX: 10, minY: 10, maxX: 130, maxY: 30 },
      { shiftKey: false, altKey: false },
      false
    );
    expect(harness.getApi().selectedAnchorIdxs).toEqual(new Set([0, 1]));

    // 2. Shift key adds enclosed anchor (idx 2 at (120,100))
    // minX: 110, minY: 90, maxX: 130, maxY: 110
    harness.getApi().handleAnchorMarquee(
      { minX: 110, minY: 90, maxX: 130, maxY: 110 },
      { shiftKey: true, altKey: false },
      false
    );
    expect(harness.getApi().selectedAnchorIdxs).toEqual(new Set([0, 1, 2]));

    // 3. Alt key subtracts enclosed anchor (idx 0 at (20,20))
    // minX: 10, minY: 10, maxX: 30, maxY: 30
    harness.getApi().handleAnchorMarquee(
      { minX: 10, minY: 10, maxX: 30, maxY: 30 },
      { shiftKey: false, altKey: true },
      false
    );
    expect(harness.getApi().selectedAnchorIdxs).toEqual(new Set([1, 2]));

    // 4. Click on empty space (isClick: true, no modifiers) clears anchor selection
    harness.getApi().handleAnchorMarquee(
      { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      { shiftKey: false, altKey: false },
      true
    );
    expect(harness.getApi().selectedAnchorIdxs).toEqual(new Set());

    harness.cleanup();
  });

  it("moves multiple selected anchors together preserving relative offsets", () => {
    const harness = setupHarness(makeDocWithRect(0));
    const origRect = getActivePage(harness.store.getDoc()).children[0] as RectElement;
    harness.getApi().startPathEdit(origRect);

    // Marquee-select top two anchors (0 and 1)
    harness.getApi().handleAnchorMarquee(
      { minX: 10, minY: 10, maxX: 130, maxY: 30 },
      { shiftKey: false, altKey: false },
      false
    );
    const selected = harness.getApi().selectedAnchorIdxs;
    expect(selected).toEqual(new Set([0, 1]));

    const currentEl = getActivePage(harness.store.getDoc()).children[0] as any;
    const path = parsePathData(currentEl.d)!;
    expect(path.anchors[0]).toEqual({ x: 0, y: 0 });
    expect(path.anchors[1]).toEqual({ x: 100, y: 0 });
    expect(path.anchors[2]).toEqual({ x: 100, y: 80 });
    expect(path.anchors[3]).toEqual({ x: 0, y: 80 });

    // Simulate multi-anchor move by dx=15, dy=-10
    const dx = 15;
    const dy = -10;
    let next = path;
    for (const idx of selected) {
      const pt = path.anchors[idx];
      next = moveAnchor(next, idx, pt.x + dx, pt.y + dy);
    }
    expect(next.anchors[0]).toEqual({ x: 15, y: -10 });
    expect(next.anchors[1]).toEqual({ x: 115, y: -10 });
    expect(next.anchors[2]).toEqual({ x: 100, y: 80 });
    expect(next.anchors[3]).toEqual({ x: 0, y: 80 });

    harness.cleanup();
  });

  it("selects anchors through UI mouse gestures (mousedown -> mousemove -> mouseup)", () => {
    const harness = setupHarness(makeDocWithRect(0));
    const origRect = getActivePage(harness.store.getDoc()).children[0] as RectElement;
    harness.getApi().startPathEdit(origRect);

    expect(harness.getApi().editingPathId).toBe("rect_1");
    expect(harness.getApi().selectedAnchorIdxs.size).toBe(0);

    // 1. Mouse down on canvas at (10, 10)
    harness.getGestures().handleCanvasMouseDown({
      clientX: 10,
      clientY: 10,
      button: 0,
      shiftKey: false,
      altKey: false
    } as any);

    // 2. Mouse move to (130, 30) (encloses top anchors at (20,20) and (120,20))
    harness.getGestures().handleCanvasMouseMove({
      clientX: 130,
      clientY: 30,
      shiftKey: false,
      altKey: false
    } as any);

    // 3. Global mouseup on window
    const upEvent = Object.assign(new Event("mouseup"), { shiftKey: false, altKey: false });
    window.dispatchEvent(upEvent);

    // 4. Verify anchors 0 and 1 are selected and path edit mode is still active
    expect(harness.getApi().selectedAnchorIdxs).toEqual(new Set([0, 1]));
    expect(harness.getApi().editingPathId).toBe("rect_1");

    harness.cleanup();
  });

  it("maintains accurate anchor marquee selection when canvas view is panned", () => {
    const harness = setupHarness(makeDocWithRect(0));
    const origRect = getActivePage(harness.store.getDoc()).children[0] as RectElement;
    harness.getApi().startPathEdit(origRect);

    // Capture element mousedown handler before panning (as occurs with memoized SVG nodes)
    const staleElementMouseDown = harness.getGestures().handleElementMouseDown;

    // Pan the canvas by (150, 80)
    harness.setPan({ x: 150, y: 80 });

    // Top anchors are at world (20, 20) and (120, 20).
    // With pan = (150, 80), in client coordinates they are at (170, 100) and (270, 100).
    // Starting marquee over the element at client (160, 90) corresponds to world (10, 10).
    staleElementMouseDown(
      {
        clientX: 160,
        clientY: 90,
        button: 0,
        stopPropagation: () => {}
      } as any,
      origRect
    );

    // Mouse move to client (280, 110) corresponds to world (130, 30)
    harness.getGestures().handleCanvasMouseMove({
      clientX: 280,
      clientY: 110,
      shiftKey: false,
      altKey: false
    } as any);

    // Global mouseup
    const upEvent = Object.assign(new Event("mouseup"), { shiftKey: false, altKey: false });
    window.dispatchEvent(upEvent);

    // Marquee should accurately enclose anchors 0 and 1 without drifting from the pan
    expect(harness.getApi().selectedAnchorIdxs).toEqual(new Set([0, 1]));

    harness.cleanup();
  });
});

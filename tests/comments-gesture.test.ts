import { describe, it, expect, vi } from "vitest";
import { createElementClick } from "../src/ui/hooks/canvas-gestures/element-click";
import type { DesignDocument, RectElement } from "../src/core/dsl/types";

const makeDoc = (): DesignDocument => ({
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
          x: 100,
          y: 100,
          width: 200,
          height: 100
        } as RectElement
      ]
    }
  ],
  activePageId: "page_1"
});

describe("Comment canvas gesture interaction", () => {
  it("intercepts mousedown on elements when activeTool is comment", () => {
    const doc = makeDoc();
    const docRef = { current: doc };
    const onCommentAtElement = vi.fn();
    const setSelectedIds = vi.fn();

    const mockContainer = {
      getBoundingClientRect: () => ({ left: 50, top: 50, width: 800, height: 600 })
    } as unknown as HTMLDivElement;

    const handler = createElementClick({
      docRef,
      selectedIds: new Set(),
      setSelectedIds,
      activeTool: "comment",
      setActiveTool: vi.fn(),
      isPanModeRef: { current: false },
      editingPathId: null,
      pan: { x: 0, y: 0 },
      zoom: 1,
      canvasContainerRef: { current: mockContainer },
      commitSnapshot: vi.fn(),
      startCanvasTextEdit: vi.fn(),
      openImageFillPanel: vi.fn(() => false),
      setShapeDraft: vi.fn(),
      setHoverSelectId: vi.fn(),
      hoverSelectIdRef: { current: null },
      isDrawingShape: { current: false },
      shapeDrawStart: { current: null },
      shapeDrawCurrent: { current: null },
      startDragGesture: vi.fn(),
      isDraggingElements: { current: false },
      dragStartMouse: { current: { x: 0, y: 0 } },
      dragStartElements: { current: new Map() },
      dragSelectionRef: { current: new Set() },
      dragPrimary: { current: null },
      dragSnapExcludeRef: { current: new Set() },
      isMarqueeActive: { current: false },
      marqueeBox: { current: null },
      onCommentAtElement
    });

    const mockElement = doc.pages[0].children[0];
    const mouseEvent = {
      button: 0,
      clientX: 170, // 170 - 50 = 120
      clientY: 180, // 180 - 50 = 130
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
      shiftKey: false,
      altKey: false
    } as unknown as MouseEvent;

    handler(mouseEvent, mockElement);

    expect(onCommentAtElement).toHaveBeenCalledTimes(1);
    expect(onCommentAtElement).toHaveBeenCalledWith(mockElement, { x: 120, y: 130 });
    // Crucially: selection should NOT be modified when placing a comment pin
    expect(setSelectedIds).not.toHaveBeenCalled();
  });
});

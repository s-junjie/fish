import { describe, it, expect } from "vitest";
import { inspectorPanelPropsEqual, type InspectorPanelProps } from "../src/ui/inspector/InspectorPanel";
import { MAX_INDIVIDUAL_SELECTION_OUTLINES } from "../src/ui/canvas/SelectionOverlay";
import { DesignDocument, RectElement } from "../src/core/dsl/types";

describe("selection zoom performance optimizations", () => {
  const dummyDoc: DesignDocument = {
    version: "0.2",
    id: "doc_1",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canvas: { width: 800, height: 600, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
    pages: [],
    activePageId: "p1",
    elements: []
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

  const baseInspectorProps: InspectorPanelProps = {
    hidden: false,
    doc: dummyDoc,
    setDoc: () => {},
    docRef: { current: dummyDoc },
    selectedElements: [el1],
    primarySelected: el1,
    selectedIds: new Set(["rect_1"]),
    setSelectedIds: () => {},
    multiBounds: null,
    is4Corners: false,
    onToggle4Corners: () => {},
    showMorphLines: true,
    onToggleLock: () => {},
    onToggleVisibility: () => {},
    onAlign: () => {},
    onBooleanAction: () => {},
    onCommitSnapshot: () => {},
    onDragStart: () => {},
    onDragEnd: () => {},
    canvasContainerRef: { current: null }
  };

  it("inspectorPanelPropsEqual returns true when zoom changes (panel props are identical)", () => {
    // During wheel/pinch zoom, EditorShell re-renders with new zoom/pan, but passes
    // referentially identical props to InspectorPanel.
    const nextProps: InspectorPanelProps = { ...baseInspectorProps };
    expect(inspectorPanelPropsEqual(baseInspectorProps, nextProps)).toBe(true);
  });

  it("inspectorPanelPropsEqual returns false when selection changes", () => {
    const nextProps: InspectorPanelProps = {
      ...baseInspectorProps,
      selectedIds: new Set(["rect_2"])
    };
    expect(inspectorPanelPropsEqual(baseInspectorProps, nextProps)).toBe(false);
  });

  it("inspectorPanelPropsEqual returns false when doc reference changes", () => {
    const nextProps: InspectorPanelProps = {
      ...baseInspectorProps,
      doc: { ...dummyDoc }
    };
    expect(inspectorPanelPropsEqual(baseInspectorProps, nextProps)).toBe(false);
  });

  it("MAX_INDIVIDUAL_SELECTION_OUTLINES caps massive selections to protect zoom/pan frame rates", () => {
    expect(MAX_INDIVIDUAL_SELECTION_OUTLINES).toBeGreaterThanOrEqual(50);
    expect(MAX_INDIVIDUAL_SELECTION_OUTLINES).toBeLessThanOrEqual(120);
  });
});

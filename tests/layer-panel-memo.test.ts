import { describe, it, expect } from "vitest";
import { layerPanelPropsEqual } from "../src/ui/LayerPanel";
import { DesignElement, Page } from "../src/core/dsl/types";

const noop = () => {};

const elements: DesignElement[] = [
  { id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }
];
const pages: Page[] = [
  {
    id: "page_a",
    name: "A",
    canvas: { unit: "px", background: { type: "solid", color: "#000" } },
    children: elements
  }
];

const baseProps = {
  elements,
  totalCount: 1,
  selectedIds: new Set<string>(),
  primarySelectedId: null,
  onSelect: noop,
  onReorder: noop,
  onToggleVisibility: noop,
  onToggleLock: noop,
  renamingId: null,
  onCommitRename: noop,
  onCancelRename: noop,
  pages,
  activePageId: "page_a",
  onSelectPage: noop,
  onAddPage: noop,
  onRenamePage: noop,
  onDeletePage: noop,
  onDuplicatePage: noop
};

describe("LayerPanel memo comparator", () => {
  it("skips a re-render when every prop is referentially stable", () => {
    expect(layerPanelPropsEqual(baseProps, { ...baseProps })).toBe(true);
  });

  it("skips a re-render when only geometry churns", () => {
    const moved: DesignElement[] = [{ ...elements[0], x: 999, y: 999 }];
    expect(layerPanelPropsEqual(baseProps, { ...baseProps, elements: moved })).toBe(true);
  });

  it("re-renders when a page callback is recreated", () => {
    expect(layerPanelPropsEqual(baseProps, { ...baseProps, onAddPage: () => {} })).toBe(false);
    expect(layerPanelPropsEqual(baseProps, { ...baseProps, onSelectPage: () => {} })).toBe(false);
  });

  // Locking is a tree-only change: geometry does not budge, so the row would keep
  // an open/closed padlock forever if `locked` were left out of the comparator.
  it("re-renders when a layer is locked or unlocked", () => {
    const locked: DesignElement[] = [{ ...elements[0], locked: true }];
    expect(layerPanelPropsEqual(baseProps, { ...baseProps, elements: locked })).toBe(false);
    expect(layerPanelPropsEqual({ ...baseProps, elements: locked }, baseProps)).toBe(false);
  });

  it("re-renders when a nested child is locked", () => {
    const frame: DesignElement[] = [
      { id: "f1", type: "frame", x: 0, y: 0, width: 100, height: 100, children: [elements[0]] }
    ];
    const lockedChild: DesignElement[] = [
      {
        ...(frame[0] as any),
        children: [{ ...elements[0], locked: true }]
      }
    ];
    expect(layerPanelPropsEqual({ ...baseProps, elements: frame }, { ...baseProps, elements: lockedChild })).toBe(
      false
    );
  });

  it("re-renders when the lock handler is recreated", () => {
    expect(layerPanelPropsEqual(baseProps, { ...baseProps, onToggleLock: () => {} })).toBe(false);
  });
});

/**
 * The half of the rule this file cannot reach: that App actually passes STABLE
 * callbacks, so `layerPanelPropsEqual` above sees identity and skips the rebuild.
 *
 * This file used to assert it by regexing `const <name> = useCallback(` out of
 * App's source. That is a lint on a name, not on behaviour: inlining the arrow
 * at the call site — the exact bug it was written to catch — leaves every
 * declaration intact and passes, and renaming a correct handler fails. It needs
 * a render test (mount App, count LayerRow renders across a write). Nothing here
 * proves App gets this right.
 */

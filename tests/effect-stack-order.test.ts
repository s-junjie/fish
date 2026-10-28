import { afterAll, describe, expect, it, vi } from "vitest";

// `isolate: false` means this registry outlives the file: without the unmock
// below, every later test sees `useMemo` run eagerly — which is fine for the
// defs these two files grade and wrong for the renderer everyone else mounts.
vi.mock("preact/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("preact/hooks")>();
  return {
    ...actual,
    useMemo: (fn: () => unknown) => fn()
  };
});

afterAll(() => {
  vi.unmock("preact/hooks");
});

import { moveStackRow, stackRows } from "../src/core/dsl/paint-stack";
import { Effect, TextElement, RectElement } from "../src/core/dsl/types";
import { CanvasDefs, ElementDefs, renderElementDefs } from "../src/ui/canvas/CanvasDefs";
import { SvgTextNode } from "../src/ui/canvas/SvgTextNode";

/**
 * The def markup, with the memo boundary taken out.
 *
 * `CanvasDefs` emits one `<ElementDefs>` per element so a drag re-renders only
 * the layer that moved; a test that wants to read the markup has to step
 * through that boundary itself.
 */
const defsMarkup = (defs: any): any[] =>
  (defs?.props?.children ?? [])
    .flat(Infinity)
    .flatMap((c: any) => (c && c.type === ElementDefs ? [renderElementDefs(c.props)] : [c]));


describe("effect stack reordering in inspector", () => {
  const dropShadow1: Effect = { type: "drop-shadow", color: "#FF0000", offset: { x: 0, y: 4 }, blur: 4, enabled: true };
  const dropShadow2: Effect = { type: "drop-shadow", color: "#0000FF", offset: { x: 0, y: 8 }, blur: 8, enabled: true };
  const innerShadow: Effect = { type: "inner-shadow", color: "#00FF00", offset: { x: 0, y: 2 }, blur: 2, enabled: true };

  it("presents effects top-first in UI rows", () => {
    // Storage: bottom-first [dropShadow1, dropShadow2, innerShadow]
    const effects = [dropShadow1, dropShadow2, innerShadow];
    const rows = stackRows(effects);

    expect(rows.map((r) => r.item)).toEqual([innerShadow, dropShadow2, dropShadow1]);
    expect(rows.map((r) => r.index)).toEqual([2, 1, 0]);
  });

  it("reorders effects when dragging UI rows", () => {
    // Storage: [dropShadow1, dropShadow2, innerShadow] -> UI: [innerShadow, dropShadow2, dropShadow1]
    const effects = [dropShadow1, dropShadow2, innerShadow];

    // Drag UI row 0 (innerShadow) down to bottom (slot 3)
    const reordered = moveStackRow(effects, 0, 3);
    // UI becomes: [dropShadow2, dropShadow1, innerShadow]
    expect(stackRows(reordered).map((r) => r.item)).toEqual([dropShadow2, dropShadow1, innerShadow]);
    // Storage becomes: [innerShadow, dropShadow1, dropShadow2]
    expect(reordered).toEqual([innerShadow, dropShadow1, dropShadow2]);

    // Drag UI row 2 (innerShadow) back to top (slot 0)
    const backToTop = moveStackRow(reordered, 2, 0);
    expect(stackRows(backToTop).map((r) => r.item)).toEqual([innerShadow, dropShadow2, dropShadow1]);
    expect(backToTop).toEqual(effects);
  });
});

describe("effects rendering from top to bottom", () => {
  const shadowTop: Effect = { type: "drop-shadow", color: "#FF0000", offset: { x: 0, y: 5 }, blur: 0, enabled: true };
  const shadowBottom: Effect = { type: "drop-shadow", color: "#0000FF", offset: { x: 0, y: 15 }, blur: 0, enabled: true };

  it("renders text shadows with the top-most inspector effect first (on top)", () => {
    // Storage order: [shadowBottom, shadowTop]
    // UI order: [shadowTop, shadowBottom]
    const textEl: TextElement = {
      id: "txt1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      content: "Hello",
      effects: [shadowBottom, shadowTop],
      style: { fontFamily: "Inter", fontSize: 16, color: "#000" }
    };

    const vnode = SvgTextNode({
      el: textEl,
      isEditingText: false,
      activeFills: [],
      activeStrokes: [],
      fillLayerIndex: () => 0,
      strokeLayerIndex: () => 0,
      ctx: {} as any
    }) as any;

    expect(vnode.props["data-text-shadow"]).toBe("0px 5px 0px #FF0000, 0px 15px 0px #0000FF");
    expect(vnode.props.children.props.style?.textShadow).toBe("0px 5px 0px #FF0000, 0px 15px 0px #0000FF");
  });

  function findDescendant(node: any, predicate: (n: any) => boolean): any {
    if (!node) return null;
    if (predicate(node)) return node;
    // Defs are emitted one `<ElementDefs>` per element now; the markup is behind
    // that component, so step through it rather than around it.
    const children = node.type === ElementDefs ? [renderElementDefs(node.props)] : Array.isArray(node)
      ? node
      : Array.isArray(node.props?.children)
      ? node.props.children
      : node.props?.children
      ? [node.props.children]
      : [];
    for (const child of children) {
      const found = findDescendant(child, predicate);
      if (found) return found;
    }
    return null;
  }

  it("emits SVG filter primitives rendering top inspector shadow over bottom shadow", () => {
    const rectEl: RectElement = {
      id: "rect1",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      effects: [shadowBottom, shadowTop]
    };

    const defs = CanvasDefs({
      allElements: [rectEl],
      selectedIds: new Set()
    }) as any;

    expect(defs).not.toBeNull();
    // Find the filter for rect1 among defs children
    const filter = findDescendant(
      defs,
      (c: any) => c && c.type === "filter" && c.props?.id === "filter_rect1"
    );
    expect(filter).toBeDefined();
    expect(filter).not.toBeNull();

    // The primitives should process shadowTop first (merging behind SourceGraphic),
    // and shadowBottom second (merging behind fx-0-drop-merge).
    // In SVG feMerge, shadowBottom is placed under (SourceGraphic over shadowTop),
    // meaning shadowTop is on top of shadowBottom!
    const primitives = (filter.props.children as any[]).flat(Infinity);
    const merges = primitives.filter((p: any) => p && p.type === "feMerge");
    expect(merges).toHaveLength(2);

    expect(merges[0].props.result).toBe("fx-0-drop-merge");
    expect(merges[1].props.result).toBe("fx-1-drop-merge");

    expect(merges[1].props.children[0].props.in).toBe("fx-1-drop-color");
    expect(merges[1].props.children[1].props.in).toBe("fx-0-drop-merge");
  });

  it("emits multiple inner shadows rendering top inspector inner shadow over bottom inner shadow", () => {
    const innerTop: Effect = { type: "inner-shadow", color: "#FFFFFF", offset: { x: 0, y: 2 }, blur: 0, enabled: true };
    const innerBottom: Effect = { type: "inner-shadow", color: "#000000", offset: { x: 0, y: 8 }, blur: 0, enabled: true };

    // Storage: [innerBottom, innerTop] -> UI: [innerTop, innerBottom]
    const rectEl: RectElement = {
      id: "rect2",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      effects: [innerBottom, innerTop]
    };

    const defs = CanvasDefs({
      allElements: [rectEl],
      selectedIds: new Set()
    }) as any;

    expect(defs).not.toBeNull();
    const filter = findDescendant(
      defs,
      (c: any) => c && c.type === "filter" && c.props?.id === "filter_rect2"
    );
    expect(filter).toBeDefined();
    expect(filter).not.toBeNull();

    // Inner shadows composite so that innerTop (UI row 0) is composited over innerBottom
    // First composite applies innerBottom over SourceGraphic
    // Second composite applies innerTop over fx-0-in-over
    const primitives = (filter.props.children as any[]).flat(Infinity);
    const composites = primitives.filter((p: any) => p && p.type === "feComposite" && p.props?.operator === "over");
    expect(composites).toHaveLength(2);
    expect(composites[1].props.in2).toBe("fx-0-in-over");
  });
});

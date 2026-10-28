import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { DesignDocument, DesignStyle, PaintStyle, StrokeStyle, TextStyleDefinition, RectElement, TextElement, InstanceElement } from "../src/core/dsl/types";
import { createPaintStyle, createStrokeStyle, createTextStyle, createEffectStyle, addStyleToDoc, updateStyleInDoc, removeStyleFromDoc, removeTokenFromDoc, updateTokenInDoc, reorderStyles, bindFillStyle, unbindFillStyle, bindCompositeStrokeStyle, unbindCompositeStrokeStyle, bindTextStyle, unbindEffectStyle } from "../src/core/interactions/style-ops";
import { buildReferenceRegistry } from "../src/ui/canvas/reference-registry";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { resolveInstanceBox } from "../src/core/interactions/instance-inherit";

function createMockDoc(): DesignDocument {
  const rect: RectElement = {
    id: "rect_1",
    type: "rect",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fills: [{ type: "solid", color: "#FF0000" }]
  };

  const text: TextElement = {
    id: "text_1",
    type: "text",
    x: 10,
    y: 10,
    width: 200,
    height: 40,
    content: "Hello Styles",
    style: {
      fontFamily: "Inter, sans-serif",
      fontSize: 16,
      fontWeight: 400,
      color: "#FFFFFF"
    }
  };

  return {
    version: "0.1",
    id: "doc_test",
    name: "Styles Test Doc",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: { unit: "px", background: { type: "solid", color: "#000000" } },
    pages: [
      {
        id: "p1",
        name: "Page 1",
        canvas: { unit: "px", background: { type: "solid", color: "#000000" } },
        children: [rect, text]
      }
    ],
    activePageId: "p1",
    elements: [rect, text],
    styles: []
  };
}

describe("Figma Styles Capability", () => {
  it("creates paint, text, and effect styles with proper structure", () => {
    const paintStyle = createPaintStyle("Brand / Primary", [{ type: "solid", color: "#3B82F6" }], "Main brand color");
    expect(paintStyle.styleType).toBe("paint");
    expect(paintStyle.name).toBe("Brand / Primary");
    expect(paintStyle.description).toBe("Main brand color");
    expect(paintStyle.paints[0]).toEqual({ type: "solid", color: "#3B82F6" });
    expect(paintStyle.id).toMatch(/^style_paint_/);

    const textStyle = createTextStyle("Heading / H1", {
      fontFamily: "Roboto, sans-serif",
      fontSize: 32,
      fontWeight: 700,
      color: "#FFFFFF"
    });
    expect(textStyle.styleType).toBe("text");
    expect(textStyle.name).toBe("Heading / H1");
    expect(textStyle.style.fontSize).toBe(32);
    expect(textStyle.id).toMatch(/^style_text_/);

    const effectStyle = createEffectStyle("Elevation / High", [
      { type: "drop-shadow", color: "#00000080", offset: { x: 0, y: 8 }, blur: 16, enabled: true }
    ]);
    expect(effectStyle.styleType).toBe("effect");
    expect(effectStyle.effects[0].type).toBe("drop-shadow");
    expect(effectStyle.id).toMatch(/^style_effect_/);
  });

  it("adds and updates styles in document with cascade to referencing elements", () => {
    let doc = createMockDoc();
    const blueStyle = createPaintStyle("Blue Style", [{ type: "solid", color: "#0000FF" }]);
    doc = addStyleToDoc(doc, blueStyle);
    expect(doc.styles?.length).toBe(1);

    // Bind rect to the paint style
    const rect = getActivePage(doc).children[0] as RectElement;
    const boundRect = bindFillStyle(rect, blueStyle);
    expect(boundRect.fillStyleId).toBe(blueStyle.id);
    expect(boundRect.fills).toEqual(blueStyle.paints);

    // Update element in doc
    getActivePage(doc).children[0] = boundRect;
    doc.pages[0].children[0] = boundRect;

    // Now update the style to green
    const updatedStyle: PaintStyle = {
      ...blueStyle,
      paints: [{ type: "solid", color: "#00FF00" }]
    };
    const nextDoc = updateStyleInDoc(doc, updatedStyle);

    // Style is updated in styles array
    expect((nextDoc.styles?.[0] as PaintStyle).paints[0]).toEqual({ type: "solid", color: "#00FF00" });

    // Referencing elements in active elements and pages are cascaded!
    const nextRect = getActivePage(nextDoc).children[0] as RectElement;
    expect(nextRect.fillStyleId).toBe(blueStyle.id);
    expect(nextRect.fills?.[0]).toEqual({ type: "solid", color: "#00FF00" });
    expect(nextDoc.pages[0].children[0].fills?.[0]).toEqual({ type: "solid", color: "#00FF00" });
  });

  it("cascades text style updates to text elements", () => {
    let doc = createMockDoc();
    const h1Style = createTextStyle("H1", {
      fontFamily: "Inter, sans-serif",
      fontSize: 28,
      fontWeight: 600,
      color: "#FFFFFF"
    });
    doc = addStyleToDoc(doc, h1Style);

    const text = getActivePage(doc).children[1] as TextElement;
    const boundText = bindTextStyle(text, h1Style);
    expect(boundText.textStyleId).toBe(h1Style.id);
    expect(boundText.style.fontSize).toBe(28);

    getActivePage(doc).children[1] = boundText;
    doc.pages[0].children[1] = boundText;

    const updatedH1: TextStyleDefinition = {
      ...h1Style,
      style: { ...h1Style.style, fontSize: 36, fontWeight: 800 }
    };
    const nextDoc = updateStyleInDoc(doc, updatedH1);

    const nextText = getActivePage(nextDoc).children[1] as TextElement;
    expect(nextText.textStyleId).toBe(h1Style.id);
    expect(nextText.style.fontSize).toBe(36);
    expect(nextText.style.fontWeight).toBe(800);
  });

  it("unbinding styles detaches link while preserving local evaluated styles", () => {
    const rect: RectElement = {
      id: "r1",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fillStyleId: "style_paint_1",
      strokeStyleId: "style_stroke_1",
      effectStyleId: "style_effect_1",
      fills: [{ type: "solid", color: "#123456" }],
      strokes: [{ width: 2, color: "#654321" }],
      effects: [{ type: "drop-shadow", color: "#000", offset: { x: 0, y: 2 }, blur: 4 }]
    };

    const unlinkedFill = unbindFillStyle(rect);
    expect(unlinkedFill.fillStyleId).toBeUndefined();
    expect(unlinkedFill.fills).toEqual(rect.fills);

    const unlinkedStroke = unbindCompositeStrokeStyle(rect);
    expect(unlinkedStroke.strokeStyleId).toBeUndefined();
    expect(unlinkedStroke.strokes?.[0]).toEqual(rect.strokes?.[0]);

    const unlinkedEffect = unbindEffectStyle(rect);
    expect(unlinkedEffect.effectStyleId).toBeUndefined();
    expect(unlinkedEffect.effects).toEqual(rect.effects);
  });

  it("reorders rows inside one style group only", () => {
    const styles = [
      { id: "p1", name: "P1", styleType: "paint", paints: [] },
      { id: "t1", name: "T1", styleType: "text", style: {} },
      { id: "p2", name: "P2", styleType: "paint", paints: [] },
      { id: "e1", name: "E1", styleType: "effect", effects: [] }
    ] as DesignStyle[];

    const ids = (list: DesignStyle[]) => list.map((s) => s.id);

    expect(ids(reorderStyles(styles, "paint", 1, 0))).toEqual(["p2", "t1", "p1", "e1"]);
    expect(ids(reorderStyles(styles, "paint", 0, 2))).toEqual(["p2", "t1", "p1", "e1"]);
    // Dropping a row back onto its own slot is a no-op, not a re-shuffle.
    expect(ids(reorderStyles(styles, "paint", 0, 1))).toEqual(["p1", "t1", "p2", "e1"]);
    expect(ids(reorderStyles(styles, "text", 0, 0))).toEqual(["p1", "t1", "p2", "e1"]);
    expect(ids(styles)).toEqual(["p1", "t1", "p2", "e1"]);
  });

  it("removing style from document cleanly clears references on elements", () => {
    let doc = createMockDoc();
    const style = createPaintStyle("My Red", [{ type: "solid", color: "#FF0000" }]);
    doc = addStyleToDoc(doc, style);

    getActivePage(doc).children[0] = { ...getActivePage(doc).children[0], fillStyleId: style.id };
    doc.pages[0].children[0] = { ...doc.pages[0].children[0], fillStyleId: style.id };

    const docAfterRemoval = removeStyleFromDoc(doc, style.id);
    expect(docAfterRemoval.styles?.some((s) => s.id === style.id)).toBe(false);
    expect(getActivePage(docAfterRemoval).children[0].fillStyleId).toBeUndefined();
    expect(docAfterRemoval.pages[0].children[0].fillStyleId).toBeUndefined();
    // Element's evaluated fills are preserved
    expect(getActivePage(docAfterRemoval).children[0].fills).toBeDefined();
  });

  it("indexes styles and tracks reverse references in ReferenceRegistry", () => {
    let doc = createMockDoc();
    const paintStyle = createPaintStyle("Accent", [{ type: "solid", color: "#3B82F6" }]);
    const textStyle = createTextStyle("Body", {
      fontFamily: "Inter, sans-serif",
      fontSize: 14,
      color: "#CCCCCC"
    });
    doc = addStyleToDoc(doc, paintStyle);
    doc = addStyleToDoc(doc, textStyle);

    getActivePage(doc).children[0] = { ...getActivePage(doc).children[0], fillStyleId: paintStyle.id };
    (getActivePage(doc).children[1] as TextElement).textStyleId = textStyle.id;
    doc.pages[0].children = [...getActivePage(doc).children];

    const registry = buildReferenceRegistry(doc);
    expect(registry.getStyle(paintStyle.id)).toEqual(paintStyle);
    expect(registry.getStyle(textStyle.id)).toEqual(textStyle);
    expect(registry.getStyles().length).toBe(2);

    const paintDependents = registry.getDependents(paintStyle.id);
    expect(paintDependents.has("rect_1")).toBe(true);

    const textDependents = registry.getDependents(textStyle.id);
    expect(textDependents.has("text_1")).toBe(true);
  });

  it("normalizes and preserves document styles and element style IDs", () => {
    const raw = {
      version: "0.1",
      canvas: { width: 800, height: 600, background: { type: "solid", color: "#000000" } },
      styles: [
        {
          id: "style_color_1",
          name: "Brand Blue",
          description: "Primary brand",
          styleType: "paint",
          paints: [{ type: "solid", color: "#0066FF" }]
        },
        {
          id: "style_text_1",
          name: "Header Large",
          styleType: "text",
          style: { fontFamily: "Inter", fontSize: 24, color: "#FFFFFF" }
        }
      ],
      elements: [
        {
          id: "node_1",
          type: "rect",
          x: 10,
          y: 20,
          width: 100,
          height: 100,
          fillStyleId: "style_color_1",
          strokeStyleId: "style_color_1",
          effectStyleId: "style_fx_1"
        },
        {
          id: "node_2",
          type: "text",
          x: 10,
          y: 150,
          width: 200,
          height: 30,
          text: "Sample text",
          textStyleId: "style_text_1"
        }
      ]
    };

    const res = normalizeDesignDocument(raw);
    const normalizedDoc = res.document;

    expect(normalizedDoc.styles?.length).toBe(2);
    expect(normalizedDoc.styles?.[0].id).toBe("style_color_1");
    expect(normalizedDoc.styles?.[0].name).toBe("Brand Blue");

    const el1 = getActivePage(normalizedDoc).children[0];
    expect(el1.fillStyleId).toBe("style_color_1");
    expect(el1.strokeStyleId).toBe("style_color_1");
    expect(el1.effectStyleId).toBe("style_fx_1");

    const el2 = getActivePage(normalizedDoc).children[1] as TextElement;
    expect(el2.textStyleId).toBe("style_text_1");
  });
});

/**
 * A shared style is dual-storage: the binding id marks which style owns the
 * stack, and the stack itself stays on the element. `resolveInstanceBox` handed
 * the Inspector the resolved *values* but not the ids, so an instance of a
 * style-bound component showed the master's colours with no binding pill — the
 * one reading the invariant exists to prevent, and it looked like the component
 * had been given its own private copy.
 */
describe("a style binding survives instantiation", () => {
  const master = {
    id: "cmp/btn",
    type: "component",
    name: "Button",
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    fills: [{ type: "solid" as const, color: "#FFFFFF" }],
    fillStyleId: "ps/surface",
    strokes: [{ color: "#111111", width: 1 }],
    strokeStyleId: "ps/hairline",
    effects: [{ type: "drop-shadow" as const, color: "rgba(0,0,0,0.1)", offset: { x: 0, y: 2 }, blur: 4 }],
    effectStyleId: "ps/rise",
    children: []
  } as any;
  const inst = (extra: any = {}) =>
    ({ id: "i", type: "instance", componentId: "cmp/btn", x: 0, y: 0, width: 120, height: 40, ...extra }) as any;

  it("carries every binding the master declares", () => {
    const box = resolveInstanceBox(inst(), master);
    expect(box.fillStyleId).toBe("ps/surface");
    expect(box.strokeStyleId).toBe("ps/hairline");
    expect(box.effectStyleId).toBe("ps/rise");
  });

  it("carries a text style binding too", () => {
    const textMaster = { ...master, id: "cmp/t", type: "component", textStyleId: "ts/label" };
    expect(resolveInstanceBox(inst(), textMaster).textStyleId).toBe("ts/label");
  });

  it("prefers the instance's own binding", () => {
    expect(resolveInstanceBox(inst({ fillStyleId: "ps/other" }), master).fillStyleId).toBe("ps/other");
  });

  it("treats an explicit null as 'detached', not as absent", () => {
    // Detaching writes `null`. `??` would read that as missing and hand back the
    // master's binding, so the detach would appear to do nothing.
    expect(resolveInstanceBox(inst({ fillStyleId: null }), master).fillStyleId).toBeNull();
    expect(resolveInstanceBox(inst({ effectStyleId: null }), master).effectStyleId).toBeNull();
  });

  it("has no binding when neither side declares one", () => {
    const bare = { ...master, fillStyleId: undefined, strokeStyleId: undefined, effectStyleId: undefined };
    const box = resolveInstanceBox(inst(), bare);
    expect(box.fillStyleId).toBeUndefined();
    expect(box.effectStyleId).toBeUndefined();
  });
});

/**
 * The write half of the same rule. `resolveInstanceBox` has always read an
 * explicit `null` as "detached", but nothing WROTE one: `unbindFillStyle` deleted
 * the key, and on an instance a deleted key means "inherit the master's". So the
 * unlink button read as a no-op, the binding pill never went away, and the colour
 * fields stayed unreachable — for fill, stroke and effect alike.
 */
describe("unlinking a style on an instance records the detach", () => {
  const master = {
    id: "cmp/btn",
    type: "component",
    name: "Button",
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    fills: [{ type: "solid" as const, color: "#3B82F6" }],
    fillStyleId: "ps/surface",
    effectStyleId: "ps/rise",
    strokeStyleId: "ps/hairline",
    effects: [{ type: "drop-shadow" as const, color: "rgba(0,0,0,0.1)", offset: { x: 0, y: 2 }, blur: 4 }],
    children: []
  } as any;
  const inst = (extra: any = {}) =>
    ({ id: "i", type: "instance", componentId: "cmp/btn", x: 0, y: 0, width: 120, height: 40, ...extra }) as any;

  it("writes null rather than deleting the key", () => {
    expect(unbindFillStyle(inst()).fillStyleId).toBeNull();
    expect(unbindCompositeStrokeStyle(inst()).strokeStyleId).toBeNull();
    expect(unbindEffectStyle(inst()).effectStyleId).toBeNull();
  });

  it("actually takes the binding off, where a deletion would not have", () => {
    const detached = unbindFillStyle(inst()) as InstanceElement;
    expect(resolveInstanceBox(detached, master).fillStyleId).toBeNull();
    // The control this is protecting: a deleted key reads back as the master's.
    expect(resolveInstanceBox(inst({ fillStyleId: undefined }), master).fillStyleId).toBe("ps/surface");
  });

  it("lets the instance paint its own colour afterwards", () => {
    const detached = {
      ...(unbindFillStyle(inst()) as InstanceElement),
      fills: [{ type: "solid" as const, color: "#FF0000" }]
    };
    const box = resolveInstanceBox(detached, master);
    expect(box.fillStyleId).toBeNull();
    expect(box.fills).toEqual([{ type: "solid", color: "#FF0000" }]);
  });

  it("survives a save and reload, which is where a dropped null comes back", () => {
    const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#000" } };
    const doc: DesignDocument = {
      id: "d",
      version: "0.1",
      name: "d",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "p", name: "P", canvas, children: [master, unbindFillStyle(inst())] as any }],
      activePageId: "p",
      elements: [master, unbindFillStyle(inst())] as any
    };
    const reloaded = normalizeDesignDocument(JSON.parse(JSON.stringify(doc))).document;
    const restored = getActivePage(reloaded).children[1] as any;
    expect(restored.fillStyleId).toBeNull();
    expect(resolveInstanceBox(restored, getActivePage(reloaded).children[0] as any).fillStyleId).toBeNull();
  });

  it("detaches a plain layer by deletion, as before", () => {
    const rect: RectElement = {
      id: "r",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fillStyleId: "ps/surface"
    };
    expect(unbindFillStyle(rect).fillStyleId).toBeUndefined();
  });

  it("stops inheriting the master's id when a bound style is deleted from the library", () => {
    const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#000" } };
    const bound = inst({ fillStyleId: "ps/surface" });
    const doc: DesignDocument = {
      id: "d",
      version: "0.1",
      name: "d",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      styles: [createPaintStyle("Surface", [{ type: "solid", color: "#3B82F6" }]) as PaintStyle & { id: string }],
      pages: [{ id: "p", name: "P", canvas, children: [master, bound] as any }],
      activePageId: "p",
      elements: [master, bound] as any
    };
    const styled = { ...doc, styles: [{ ...doc.styles![0], id: "ps/surface" } as any] };
    const pruned = removeStyleFromDoc(styled, "ps/surface");
    const kept = pruned.pages![0].children[1] as any;
    expect(kept.fillStyleId).toBeNull();
    expect(resolveInstanceBox(kept, master).fillStyleId).toBeNull();
  });

  it("freezes the current style paints onto local fills when detached with style", () => {
    const style = createPaintStyle("Accent blue", [{ type: "solid", color: "#A9C4E4" }]);
    const rect: RectElement = {
      id: "r",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fillStyleId: style.id,
      fills: [{ type: "solid", color: "#000000" }]
    };
    const detached = unbindFillStyle(rect, style);
    expect(detached.fillStyleId).toBeUndefined();
    expect(detached.fills).toEqual([{ type: "solid", color: "#A9C4E4" }]);
  });

  it("cascades style updates to instance overrides", () => {
    const style = createPaintStyle("Blue", [{ type: "solid", color: "#0000FF" }]);
    const instEl: InstanceElement = {
      id: "inst1",
      type: "instance",
      componentId: "cmp1",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      overrides: [
        { targetId: "c1", property: "fillStyleId", value: style.id },
        { targetId: "c1", property: "fills", value: [{ type: "solid", color: "#000000" }] }
      ]
    };
    const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#000" } };
    const doc: DesignDocument = {
      id: "d",
      version: "0.1",
      name: "d",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      styles: [style],
      pages: [{ id: "p", name: "P", canvas, children: [instEl] }],
      activePageId: "p",
      elements: [instEl]
    };

    const updated = updateStyleInDoc(doc, { ...style, paints: [{ type: "solid", color: "#A9C4E4" }] });
    const updatedInst = getActivePage(updated).children[0] as InstanceElement;
    const fillsOv = updatedInst.overrides?.find((o) => o.targetId === "c1" && o.property === "fills");
    expect(fillsOv?.value).toEqual([{ type: "solid", color: "#A9C4E4" }]);
  });

  it("supports token bindings inside TextStyleDefinition and cascades token updates", () => {
    const numToken = {
      id: "tok_fs",
      name: "font-size/lg",
      type: "number" as const,
      value: 20,
      category: "typography" as const
    };
    const textStyle = createTextStyle("Title/Lg", {
      fontFamily: "Inter",
      fontSize: 20,
      color: "#FFFFFF",
      tokenBindings: { fontSize: numToken.id }
    });

    const textEl: TextElement = {
      id: "t1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      content: "Hello",
      textStyleId: textStyle.id,
      style: {
        fontFamily: "Inter",
        fontSize: 20,
        color: "#FFFFFF",
        tokenBindings: { fontSize: numToken.id }
      },
      tokenBindings: { fontSize: numToken.id }
    };

    const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#000" } };
    const doc: DesignDocument = {
      id: "d",
      version: "0.1",
      name: "d",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      tokens: [numToken],
      styles: [textStyle],
      pages: [{ id: "p", name: "P", canvas, children: [textEl] }],
      activePageId: "p",
      elements: [textEl]
    };

    // Update number token from 20 to 24
    const updatedDoc = updateTokenInDoc(doc, { ...numToken, value: 24 });
    const updatedTextStyle = updatedDoc.styles?.find((s) => s.id === textStyle.id) as TextStyleDefinition;
    expect(updatedTextStyle.style.fontSize).toBe(24);
    expect(updatedTextStyle.style.tokenBindings?.fontSize).toBe(numToken.id);

    const updatedTextEl = getActivePage(updatedDoc).children[0] as TextElement;
    expect(updatedTextEl.style?.fontSize).toBe(24);
  });

  it("supports color token references inside PaintStyle and cascades color updates", () => {
    const colorToken = {
      id: "tok_primary",
      name: "Color/Primary",
      type: "color" as const,
      value: "#3B82F6"
    };
    const paintStyle = createPaintStyle("Surface/Primary", [
      { type: "solid", color: "#3B82F6", tokenId: colorToken.id }
    ]);

    const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#000" } };
    const doc: DesignDocument = {
      id: "d",
      version: "0.1",
      name: "d",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      tokens: [colorToken],
      styles: [paintStyle],
      pages: [{ id: "p", name: "P", canvas, children: [] }],
      activePageId: "p",
      elements: []
    };

    // Update color token
    const updatedDoc = updateTokenInDoc(doc, { ...colorToken, value: "#1D4ED8" });
    const updatedPaintStyle = updatedDoc.styles?.find((s) => s.id === paintStyle.id) as PaintStyle;
    const firstPaint = updatedPaintStyle.paints[0];
    expect(firstPaint.type === "solid" ? firstPaint.color : undefined).toBe("#1D4ED8");
    expect(firstPaint.tokenId).toBe(colorToken.id);
  });

  it("cleans up token references in styles when a token is removed", () => {
    const numToken = {
      id: "tok_blur",
      name: "blur/sm",
      type: "number" as const,
      value: 4,
      category: "effect" as const
    };
    const fxStyle = createEffectStyle("Shadow/Sm", [
      {
        type: "drop-shadow",
        color: "#00000040",
        offset: { x: 0, y: 2 },
        blur: 4,
        tokenBindings: { blur: numToken.id }
      }
    ]);

    const canvas = { width: 800, height: 600, unit: "px" as const, background: { type: "solid" as const, color: "#000" } };
    const doc: DesignDocument = {
      id: "d",
      version: "0.1",
      name: "d",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      tokens: [numToken],
      styles: [fxStyle],
      pages: [{ id: "p", name: "P", canvas, children: [] }],
      activePageId: "p",
      elements: []
    };

    const docAfterRemove = removeTokenFromDoc(doc, numToken.id);
    const updatedFx = docAfterRemove.styles?.find((s) => s.id === fxStyle.id) as any;
    expect(updatedFx.effects[0].tokenBindings).toBeUndefined();
    expect(updatedFx.effects[0].blur).toBe(4);
  });

  it("creates, binds, updates, unbinds, and removes composite stroke styles", () => {
    let doc = createMockDoc();
    const strokeStyle = createStrokeStyle("Border / Default", [
      { color: "#3B82F6", width: 2, align: "inside", enabled: true }
    ], "Main border style");

    expect(strokeStyle.styleType).toBe("stroke");
    expect(strokeStyle.name).toBe("Border / Default");
    expect(strokeStyle.description).toBe("Main border style");
    expect(strokeStyle.strokes[0].width).toBe(2);
    expect(strokeStyle.id).toMatch(/^style_stroke_/);

    doc = addStyleToDoc(doc, strokeStyle);
    expect(doc.styles?.find((s) => s.id === strokeStyle.id)).toBeDefined();

    const rect = getActivePage(doc).children[0] as RectElement;
    const bound = bindCompositeStrokeStyle(rect, strokeStyle);
    expect(bound.strokeStyleId).toBe(strokeStyle.id);
    expect(bound.strokes?.[0].width).toBe(2);
    expect(bound.strokes?.[0].color).toBe("#3B82F6");

    getActivePage(doc).children[0] = bound;
    doc.pages[0].children[0] = bound;

    // Update style in doc cascades to bound element
    const updatedStyle: StrokeStyle = {
      ...strokeStyle,
      strokes: [{ color: "#EF4444", width: 4, align: "inside", enabled: true }]
    };
    doc = updateStyleInDoc(doc, updatedStyle);
    const updatedRect = getActivePage(doc).children[0] as RectElement;
    expect(updatedRect.strokes?.[0].color).toBe("#EF4444");
    expect(updatedRect.strokes?.[0].width).toBe(4);

    // Unbind keeps the evaluated strokes
    const unbound = unbindCompositeStrokeStyle(updatedRect, updatedStyle);
    expect(unbound.strokeStyleId).toBeUndefined();
    expect(unbound.strokes?.[0].color).toBe("#EF4444");
    expect(unbound.strokes?.[0].width).toBe(4);

    // Removing style from doc detaches strokeStyleId
    getActivePage(doc).children[0] = bound;
    const docWithoutStyle = removeStyleFromDoc(doc, strokeStyle.id);
    const rectAfterDelete = getActivePage(docWithoutStyle).children[0] as RectElement;
    expect(rectAfterDelete.strokeStyleId).toBeUndefined();
  });

  it("normalizes stroke styles from document payload", () => {
    const raw = {
      version: "0.1",
      id: "doc_stroke_test",
      canvas: { unit: "px", background: { type: "solid", color: "#000" } },
      pages: [{ id: "p1", name: "P1", canvas: { unit: "px", background: { type: "solid", color: "#000" } }, children: [] }],
      elements: [],
      styles: [
        {
          id: "style_stroke_custom",
          name: "Dashed Outline",
          styleType: "stroke",
          strokes: [{ color: "#10B981", width: 3, align: "center", style: "dashed" }]
        }
      ]
    };

    const normalized = normalizeDesignDocument(raw).document;
    expect(normalized.styles?.length).toBe(1);
    const st = normalized.styles?.[0] as StrokeStyle;
    expect(st.styleType).toBe("stroke");
    expect(st.name).toBe("Dashed Outline");
    expect(st.strokes[0].width).toBe(3);
    expect(st.strokes[0].color).toBe("#10B981");
  });
});

/**
 * A text style declares TYPE, and only type (`TEXT_STYLE_KEYS`).
 *
 * The style editor renders a control per entry and the layer inspector hides a
 * control per entry, so a key outside the list would be a value with no home:
 * uneditable in the style panel, and pinned on every layer it binds. Ink is the
 * first case — it belongs to the layer's `fills` — and alignment, figures and
 * clipping are the rest.
 */
describe("a text style declares type, and only type", () => {
  const docWith = (style: Record<string, unknown>) =>
    normalizeDesignDocument({
      version: "0.1",
      id: "d",
      name: "d",
      canvas: { width: 100, height: 100 },
      elements: [],
      styles: [{ id: "style_text_1", name: "Body", styleType: "text", style }]
    });

  it("drops the colour a caller hands over", () => {
    const style = createTextStyle("Body", { fontFamily: "Inter", fontSize: 16, color: "#FF0000" });
    expect("color" in style.style).toBe(false);
    expect(style.style.fontSize).toBe(16);
  });

  it("drops an authored colour on load and reports it", () => {
    const { document, repairs } = docWith({ fontSize: 20, color: "#FF0000" });
    const style = document.styles?.[0] as TextStyleDefinition;
    expect("color" in style.style).toBe(false);
    const reported = repairs.filter((r) => r.path.endsWith("/style/color"));
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain("#FF0000");
  });

  it("reports nothing when the style never stated a colour", () => {
    const { document, repairs } = docWith({ fontSize: 20 });
    expect((document.styles?.[0] as TextStyleDefinition).style.fontSize).toBe(20);
    expect(repairs.filter((r) => r.path.includes("/style/color"))).toEqual([]);
  });

  it("refuses what is not a type declaration", () => {
    const { document, repairs } = docWith({ fontSize: 20, align: "center", maxLines: 2 });
    const style = document.styles?.[0] as TextStyleDefinition;
    expect("align" in style.style).toBe(false);
    expect("maxLines" in style.style).toBe(false);
    expect(repairs.map((r) => r.path).sort()).toEqual([
      "/styles[0]/style/align",
      "/styles[0]/style/maxLines"
    ]);
  });

  it("keeps every declaration the style DOES own", () => {
    const { document, repairs } = docWith({
      fontFamily: "Avenir Next",
      fontSize: 12,
      fontWeight: 500,
      fontStyle: "italic",
      lineHeight: 1.4,
      letterSpacing: -0.2,
      textDecoration: ["underline"],
      textTransform: "uppercase"
    });
    const style = (document.styles?.[0] as TextStyleDefinition).style;
    expect(style).toEqual({
      fontFamily: "Avenir Next",
      fontSize: 12,
      fontWeight: 500,
      fontStyle: "italic",
      lineHeight: 1.4,
      letterSpacing: -0.2,
      textDecoration: ["underline"],
      textTransform: "uppercase"
    });
    expect(repairs.filter((r) => r.path.includes("/style/"))).toEqual([]);
  });

  it("keeps the rest of the declarations it was given", () => {
    const style = createTextStyle("Body", {
      fontFamily: "Georgia",
      fontSize: 18,
      fontWeight: 600,
      lineHeight: 1.4,
      color: "#FF0000"
    });
    expect(style.style).toEqual({
      fontFamily: "Georgia",
      fontSize: 18,
      fontWeight: 600,
      lineHeight: 1.4
    });
  });
});

describe("a text style's shadow is refused, and says so", () => {
  const docWith = (style: Record<string, unknown>, effects?: unknown[]) =>
    normalizeDesignDocument({
      version: "0.1",
      id: "d",
      name: "d",
      canvas: { width: 100, height: 100 },
      elements: [],
      styles: [
        {
          id: "style_text_1",
          name: "Glow",
          styleType: "text",
          style,
          ...(effects ? { effects } : {})
        }
      ]
    });

  it("drops a CSS textShadow instead of folding it, and reports it", () => {
    const { document, repairs } = docWith({ fontSize: 20, textShadow: "0 0 12px #00ffff" });
    const style = document.styles?.[0] as TextStyleDefinition;
    expect(Object.keys(style.style)).not.toContain("textShadow");
    expect("effects" in style).toBe(false);
    const reported = repairs.filter((r) => r.path.endsWith("/style/textShadow"));
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain("a shadow belongs to the layer");
  });

  it("drops a stored effects array, and reports it", () => {
    const { document, repairs } = docWith({ fontSize: 20 }, [
      { type: "drop-shadow", color: "#00000080", offset: { x: 0, y: 4 }, blur: 8 }
    ]);
    const style = document.styles?.[0] as TextStyleDefinition;
    expect("effects" in style).toBe(false);
    const reported = repairs.filter((r) => r.path === "/styles[0]/effects");
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain("declares type only");
  });

  it("cannot be created with one: the constructor has no effects argument", () => {
    const style = createTextStyle("Body", { fontFamily: "Inter", fontSize: 16 });
    expect(Object.keys(style).sort()).toEqual(["id", "name", "style", "styleType"]);
  });

  it("does not touch the layer's own shadow when bound", () => {
    const shadow = { type: "drop-shadow" as const, color: "#00000080", offset: { x: 0, y: 4 }, blur: 8 };
    const element = { ...(getActivePage(createMockDoc()).children[1] as TextElement), effects: [shadow] };
    const bound = bindTextStyle(element, createTextStyle("Body", { fontFamily: "Inter", fontSize: 16 }));
    expect(bound.effects).toEqual([shadow]);
  });
});


import { describe, expect, it } from "vitest";
import { loadCollect } from "./helpers/figma-plugin-runtime";
import { createFigmaTokens } from "../src/core/import/figma-tokens";
import { createFigmaStyles } from "../src/core/import/figma-styles";
import { importFigmaFile } from "../src/core/import/figma-import";
import { mapFigmaNode, type NodeWalkState } from "../src/core/import/figma-node";
import { parseFigmaExport } from "../src/core/import/figma-export";
import type {
  FigmaFileResponse,
  FigmaNode,
  FigmaStyle,
  FigmaVariable,
  FigmaVariableCollection
} from "../src/core/import/figma-types";
import type { DesignToken, EffectStyle, PaintStyle, TextStyleDefinition } from "../src/core/dsl/types";

const solid = (r: number, g: number, b: number) => ({ type: "SOLID", color: { r, g, b, a: 1 } });

const COLLECTION: FigmaVariableCollection = {
  id: "c1",
  name: "Theme",
  defaultModeId: "m1",
  modes: [{ modeId: "m1", name: "Light" }]
};

const SURFACE: FigmaVariable = {
  id: "v1",
  name: "color/surface",
  resolvedType: "COLOR",
  variableCollectionId: "c1",
  valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }
};

const SIZE: FigmaVariable = {
  id: "v2",
  name: "font/body",
  resolvedType: "FLOAT",
  variableCollectionId: "c1",
  valuesByMode: { m1: 14 }
};

const boundColor = { type: "VARIABLE_ALIAS", id: "v1" } as const;
const boundSize = { type: "VARIABLE_ALIAS", id: "v2" } as const;

const surfaceStyle = (overrides: Partial<FigmaStyle> = {}): FigmaStyle =>
  paintStyle({
    id: "S:5",
    key: "k5",
    name: "surface/hero",
    paints: [solid(1, 1, 1), solid(0, 0, 0)],
    ...overrides
  });

const paintStyle = (overrides: Partial<FigmaStyle> = {}): FigmaStyle => ({
  id: "S:1",
  key: "k1",
  name: "surface/card",
  styleType: "PAINT",
  paints: [{ ...solid(1, 1, 1), boundVariables: { color: boundColor } }],
  ...overrides
});

const textStyle = (overrides: Partial<FigmaStyle> = {}): FigmaStyle => ({
  id: "S:2",
  key: "k2",
  name: "body/regular",
  styleType: "TEXT",
  fontFamily: "Inter",
  fontSize: 14,
  fontWeight: 400,
  lineHeightPx: 22,
  letterSpacing: 0.2,
  fills: [solid(0.1, 0.1, 0.1)],
  boundVariables: { fontSize: boundSize },
  ...overrides
});

const effectStyle = (): FigmaStyle => ({
  id: "S:3",
  key: "k3",
  name: "shadow/card",
  styleType: "EFFECT",
  effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0 }]
});

const tokensFor = (variables: FigmaVariable[] = [SURFACE, SIZE], tokens?: readonly DesignToken[]) =>
  createFigmaTokens(variables, [COLLECTION], { tokens });

const frameWithStyles = (styles: Record<string, string>): FigmaNode =>
  ({
    id: "1:1",
    name: "Card",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 80 },
    size: { x: 120, y: 80 },
    fills: [solid(1, 1, 1)],
    styles
  }) as unknown as FigmaNode;

describe("the plugin's style collection", () => {
  it("carries a paint style's values and the variable its paint is bound to", () => {
    const collected = loadCollect().collectStyles([
      {
        id: "S:1",
        key: "k1",
        name: "surface/card",
        type: "PAINT",
        paints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "v1" } } }]
      }
    ]);
    expect(collected?.[0]).toMatchObject({ id: "S:1", name: "surface/card", styleType: "PAINT" });
    const paints = collected?.[0].paints as Array<{ color: unknown; boundVariables: unknown }>;
    expect(paints[0].boundVariables).toEqual({ color: { type: "VARIABLE_ALIAS", id: "v1" } });
  });

  it("turns a plugin text style into the TypeStyle spelling the mapper reads", () => {
    const collected = loadCollect().collectStyles([
      {
        id: "S:2",
        name: "body/regular",
        type: "TEXT",
        fontName: { family: "Inter", style: "Bold Italic" },
        fontSize: 14,
        lineHeight: { unit: "PIXELS", value: 22 },
        letterSpacing: { unit: "PERCENT", value: 50 },
        textCase: "UPPER",
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]
      }
    ]);
    expect(collected?.[0]).toMatchObject({
      styleType: "TEXT",
      fontFamily: "Inter",
      fontSize: 14,
      fontWeight: 700,
      italic: true,
      lineHeightPx: 22,
      letterSpacing: 7,
      textCase: "UPPER"
    });
    expect(collected?.[0].fills).toHaveLength(1);
  });

  it("drops a style whose kind it cannot name rather than shipping half of it", () => {
    expect(loadCollect().collectStyles([{ id: "S:9", type: "SOMETHING" }])).toBeUndefined();
    expect(loadCollect().collectStyles([])).toBeUndefined();
  });

  it("renames a node's five style fields into the one map the app reads", () => {
    const collected = loadCollect().collectNode({
      id: "1:1",
      name: "Card",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      fillStyleId: "S:1",
      textStyleId: "S:2"
    });
    expect(collected?.styles).toEqual({ fill: "S:1", text: "S:2" });
  });

  it("puts the file's styles beside the document, collected", () => {
    const envelope = loadCollect().buildExport([{ id: "0:1", name: "Page", nodes: [] }], {
      styles: [{ id: "S:1", name: "surface/card", type: "PAINT", paints: [solid(1, 1, 1)] }]
    }) as { styles?: Array<Record<string, unknown>> };
    expect(envelope.styles?.[0]).toMatchObject({ id: "S:1", styleType: "PAINT" });
  });
});

describe("createFigmaStyles", () => {
  /**
   * A colour style keeps its NAME and follows the variable through its paint:
   * `paints[0].tokenId`. Collapsing it into the token (the pre-split behaviour)
   * threw the style's name away and made one thing stand for two — a palette
   * step and the semantic name over it.
   */
  it("keeps a colour style bound to a variable, following it through paints[0].tokenId", () => {
    const tokens = tokensFor();
    const index = createFigmaStyles([paintStyle()], tokens);
    const id = index.link("S:1");
    const style = index.styles[0] as PaintStyle;
    expect(id).toBe(style.id);
    expect(style.name).toBe("surface/card");
    expect(style.paints[0].tokenId).toBe(tokens.token("v1"));
    expect(index.links).toBe(1);
  });

  it("mints a surface style for a stack a token cannot hold, binding the layer it can", () => {
    const tokens = tokensFor();
    const stack: FigmaStyle = {
      ...surfaceStyle(),
      paints: [{ ...solid(1, 1, 1), boundVariables: { color: boundColor } }, solid(0, 0, 0)]
    };
    const index = createFigmaStyles([stack], tokens);
    const id = index.link("S:5");
    const style = index.styles[0] as PaintStyle;
    expect(id).toBe(style.id);
    expect(style.name).toBe("surface/hero");
    expect(style.paints[0].tokenId).toBe(tokens.token("v1"));
    expect(style.paints).toHaveLength(2);
  });

  it("mints a plain colour token for a solid no variable backs", () => {
    const index = createFigmaStyles([paintStyle({ id: "S:6", key: "k6", name: "brand/ink", paints: [solid(0, 0, 0)] })], tokensFor());
    const style = index.link("S:6");
    expect(style).toBe(index.styles[0].id);
    expect(index.styles[0]).toMatchObject({ name: "brand/ink", styleType: "paint" });
  });

  it("mints a text style with the size token it is bound to", () => {
    const tokens = tokensFor();
    const index = createFigmaStyles([textStyle()], tokens);
    index.link("S:2");
    const style = index.styles[0] as TextStyleDefinition;
    expect(style.style).toMatchObject({ fontFamily: "Inter", fontSize: 14, letterSpacing: 0.2, lineHeight: "22px" });
    expect(style.style.tokenBindings).toEqual({ fontSize: tokens.token("v2") });
  });

  it("mints an effect style with the shadow it defines", () => {
    const index = createFigmaStyles([effectStyle()], tokensFor());
    index.link("S:3");
    const style = index.styles[0] as EffectStyle;
    expect(style.effects[0]).toMatchObject({ type: "drop-shadow", blur: 12, offset: { x: 0, y: 4 } });
  });

  it("mints one style for two layers that name it, and counts both links", () => {
    const index = createFigmaStyles([surfaceStyle()], tokensFor());
    const first = index.link("S:5");
    const second = index.link("S:5");
    expect(second).toBe(first);
    expect(index.styles).toHaveLength(1);
    expect(index.links).toBe(2);
  });

  it("reuses a style the document already has instead of duplicating it", () => {
    const first = tokensFor();
    const existing = createFigmaStyles([surfaceStyle()], first, {});
    existing.link("S:5");

    // A document holds two tables, so that is what a second import is given:
    // with its token missing it would mint a new one, and the reused style's
    // paint would then point at a different id.
    const documentTokens = first.tokens;
    const documentStyles = existing.styles;
    const second = createFigmaStyles([surfaceStyle()], tokensFor(undefined, documentTokens), {
      styles: documentStyles
    });
    expect(second.link("S:5")).toBe(existing.styles[0].id);
    expect(second.styles).toHaveLength(0);
  });

  it("binds nothing when the payload is REST's value-less directory", () => {
    const index = createFigmaStyles({ "S:1": { id: "S:1", name: "surface/card", styleType: "FILL" } } as never, tokensFor());
    expect(index.link("S:1")).toBeUndefined();
    expect(index.styles).toHaveLength(0);
  });

  it("names a grid style as a gap instead of inventing one", () => {
    const index = createFigmaStyles([{ id: "S:4", name: "grid/cards", styleType: "GRID" }], tokensFor());
    expect(index.link("S:4")).toBeUndefined();
    expect(index.unsupported).toEqual([{ id: "S:4", name: "grid/cards", styleType: "GRID" }]);
  });

  it("resolves a style by its REST key as well as by its id", () => {
    const index = createFigmaStyles([paintStyle()], tokensFor());
    expect(index.link("k1")).toBe(index.link("S:1"));
  });
});

describe("mapFigmaNode with styles", () => {
  const stateWith = (styles: FigmaStyle[]): NodeWalkState => {
    const tokens = tokensFor();
    return {
      measured: new Map(),
      gaps: [],
      imageRefs: [],
      elementCount: 0,
      maxElements: 1000,
      usedIds: new Set(),
      tokens,
      styles: createFigmaStyles(styles, tokens)
    };
  };

  it("points the fill axis at the style the layer names", () => {
    const state = stateWith([surfaceStyle()]);
    const el = mapFigmaNode(frameWithStyles({ fill: "S:5" }), 0, 0, state) as unknown as Record<string, unknown>;
    expect(el.fillStyleId).toBe(state.styles?.styles[0].id);
    expect((el.fills as Array<{ color: string }>)[0].color.toLowerCase()).toBe("#ffffff");
  });

  it("keeps a text style off a layer that is not text", () => {
    const state = stateWith([textStyle()]);
    const el = mapFigmaNode(frameWithStyles({ text: "S:2" }), 0, 0, state) as unknown as Record<string, unknown>;
    expect(el.textStyleId).toBeUndefined();
    expect(state.styles?.styles).toHaveLength(0);
  });
});

describe("importFigmaFile with styles", () => {
  const file = (node: FigmaNode): FigmaFileResponse =>
    ({
      name: "Styles",
      document: { id: "0:0", name: "Doc", type: "DOCUMENT", children: [{ id: "0:1", name: "Page", type: "CANVAS", children: [node] }] },
      variables: [SURFACE, SIZE],
      variableCollections: [COLLECTION],
      styles: [paintStyle()]
    }) as unknown as FigmaFileResponse;

  it("points a layer at the colour style, which follows the variable it is built on", async () => {
    const result = await importFigmaFile(file(frameWithStyles({ fill: "S:1" })));
    // The style survives as a style now, and the variable as its token.
    expect(result.report.stylesCreated).toBe(1);
    expect(result.report.styleLinks).toBe(1);
    expect(result.report.tokensCreated).toBe(1);
    expect(result.tokens?.tokens).toHaveLength(1);
    const frame = result.elements[0] as unknown as { fillStyleId?: string };
    const style = result.tokens?.styles[0] as PaintStyle;
    expect(frame.fillStyleId).toBe(style.id);
    expect(style.paints[0].tokenId).toBe(result.tokens?.tokens[0].id);
  });

  it("ships a composite style beside the tokens, with the stack it came in", async () => {
    const payload = {
      ...file(frameWithStyles({ fill: "S:5" })),
      styles: [surfaceStyle()]
    } as unknown as FigmaFileResponse;
    const result = await importFigmaFile(payload);
    expect(result.report.stylesCreated).toBe(1);
    expect(result.report.styleLinks).toBe(1);
    const frame = result.elements[0] as unknown as { fillStyleId?: string };
    const style = result.tokens?.styles.find((s) => s.name === "surface/hero");
    expect(frame.fillStyleId).toBe(style?.id);
  });

  it("names a grid style in the gaps rather than dropping it", async () => {
    const payload = {
      ...file(frameWithStyles({ grid: "S:4" })),
      styles: [{ id: "S:4", name: "grid/cards", styleType: "GRID" }]
    } as unknown as FigmaFileResponse;
    const result = await importFigmaFile(payload);
    expect(result.report.unmapped.some((gap) => gap.property === "style:grid")).toBe(true);
  });

  /**
   * The whole door in one go: the shim writes the envelope, the app unwraps it,
   * and the style that came out of Figma reaches a layer. A style that survives
   * both halves is the only evidence the two agree.
   */
  it("carries styles from the plugin's own envelope through to the layer", async () => {
    const buildExport = loadCollect().buildExport as unknown as (
      groups: unknown[],
      meta: Record<string, unknown>
    ) => Record<string, unknown>;
    // The plugin's own spelling: five flat `…StyleId` fields, which the shim is
    // the only thing that rewrites into the `styles` map the app reads.
    const pluginNode = { ...frameWithStyles({}), fillStyleId: "S:1" } as unknown as FigmaNode;
    const envelope = buildExport([{ id: "0:1", name: "Page", nodes: [pluginNode] }], {
      variables: [SURFACE, SIZE],
      variableCollections: [COLLECTION],
      styles: [
        {
          id: "S:1",
          key: "k1",
          name: "surface/card",
          type: "PAINT",
          paints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "v1" } } }]
        }
      ]
    });

    const parsed = parseFigmaExport(envelope);
    expect(parsed.styles).toHaveLength(1);

    const result = await importFigmaFile({
      document: parsed.document,
      variables: parsed.variables,
      variableCollections: parsed.variableCollections,
      styles: parsed.styles
    });
    expect(result.report.styleLinks).toBe(1);
    const frame = result.elements[0] as unknown as { fillStyleId?: string };
    // The layer lands on the STYLE; the style's paint follows the variable's TOKEN.
    const style = result.tokens?.styles.find((s) => s.name === "surface/card") as PaintStyle | undefined;
    const token = result.tokens?.tokens.find((t) => t.name === "color/surface");
    expect(style).toBeTruthy();
    expect(token).toBeTruthy();
    expect(frame.fillStyleId).toBe(style?.id);
    expect(style?.paints[0].tokenId).toBe(token?.id);
  });
});

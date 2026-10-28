import { describe, expect, it } from "vitest";
import { loadCollect } from "./helpers/figma-plugin-runtime";
import { categoryOf, createFigmaTokens } from "../src/core/import/figma-tokens";
import { importFigmaFile } from "../src/core/import/figma-import";
import { mapFigmaNode, type NodeWalkState } from "../src/core/import/figma-node";
import { parseFigmaExport } from "../src/core/import/figma-export";
import type {
  FigmaFileResponse,
  FigmaNode,
  FigmaVariable,
  FigmaVariableAlias,
  FigmaVariableCollection
} from "../src/core/import/figma-types";
import type { ColorToken, NumberToken } from "../src/core/dsl/types";

const solid = (r: number, g: number, b: number, a = 1) => ({ type: "SOLID", color: { r, g, b, a } });
const alias = (id: string): FigmaVariableAlias => ({ type: "VARIABLE_ALIAS", id });

const COLLECTION: FigmaVariableCollection = {
  id: "c1",
  name: "Theme",
  defaultModeId: "m1",
  modes: [
    { modeId: "m1", name: "Light" },
    { modeId: "m2", name: "Dark" }
  ]
};

const CANVAS: FigmaVariable = {
  id: "v1",
  name: "bg/canvas",
  resolvedType: "COLOR",
  variableCollectionId: "c1",
  valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 }, m2: { r: 0.04, g: 0.04, b: 0.04, a: 1 } }
};

const RADIUS: FigmaVariable = {
  id: "v2",
  name: "radius/card",
  resolvedType: "FLOAT",
  variableCollectionId: "c1",
  valuesByMode: { m1: 12, m2: 12 }
};

/** A frame with one fill bound to `v1` and its radius bound to `v2`. */
const boundFrame = (fills: unknown[] = [solid(1, 1, 1)]): FigmaNode => ({
  id: "1:1",
  name: "Card",
  type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 80 },
  size: { x: 120, y: 80 },
  fills,
  cornerRadius: 12,
  boundVariables: { fills: [alias("v1")], cornerRadius: alias("v2") }
} as unknown as FigmaNode);

const stateWith = (variables: FigmaVariable[], collections: FigmaVariableCollection[] = [COLLECTION]): NodeWalkState => ({
  measured: new Map(),
  gaps: [],
  imageRefs: [],
  elementCount: 0,
  maxElements: 1000,
  usedIds: new Set(),
  tokens: createFigmaTokens(variables, collections)
});

describe("createFigmaTokens", () => {
  it("mints a colour token for the variable a fill is bound to", () => {
    const tokens = createFigmaTokens([CANVAS], [COLLECTION]);
    const lookup = tokens.lookup(boundFrame());
    expect(lookup.paint("fills", 0)).toBe(tokens.tokens[0].id);
    expect(tokens.tokens[0]).toMatchObject({ name: "bg/canvas", type: "color", value: "#FFFFFF" });
  });

  it("files the collection's other mode under the token's dark value", () => {
    const tokens = createFigmaTokens([CANVAS], [COLLECTION]);
    tokens.lookup(boundFrame()).paint("fills", 0);
    const token = tokens.tokens[0] as ColorToken;
    expect(token.modes?.dark).toBe("#0A0A0A");
    expect(tokens.colorModes).toEqual([{ id: "dark", name: "Dark" }]);
    // A colour collection never reaches the number axis.
    expect(tokens.numberModes).toEqual([]);
  });

  it("mints a number token with the category the variable's name decides", () => {
    const tokens = createFigmaTokens([RADIUS], [COLLECTION]);
    const scalars = tokens.lookup(boundFrame()).scalars();
    expect(scalars).toEqual([{ field: "borderRadius", tokenId: tokens.tokens[0].id }]);
    expect(tokens.tokens[0]).toMatchObject({ name: "radius/card", type: "number", value: 12, category: "radius" });
  });

  it("names every mode but the collection's default, not just the dark one", () => {
    const spaced: FigmaVariable = {
      id: "v3",
      name: "space/md",
      resolvedType: "FLOAT",
      variableCollectionId: "c2",
      valuesByMode: { m1: 16, m3: 24 }
    };
    const tokens = createFigmaTokens([spaced], [
      { id: "c2", name: "Density", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Comfortable" }, { modeId: "m3", name: "Compact" }] }
    ]);
    tokens.lookup({ ...boundFrame(), boundVariables: { itemSpacing: alias("v3") } }).scalars();
    expect((tokens.tokens[0] as NumberToken).modes).toEqual({ "mode_compact": 24 });
    expect(tokens.numberModes).toEqual([{ id: "mode_compact", name: "Compact" }]);
    // …and a density collection never reaches the colour axis.
    expect(tokens.colorModes).toEqual([]);
  });

  /**
   * An alias has no FISH counterpart — there is no reference token — so it is
   * followed and SHARES the target's token. Two names, one token, which is what
   * the designer meant: change the base and both follow.
   */
  it("follows an alias to the token the target already has", () => {
    const semantic: FigmaVariable = {
      id: "v4",
      name: "surface/card",
      resolvedType: "COLOR",
      variableCollectionId: "c1",
      valuesByMode: { m1: alias("v1") }
    };
    const tokens = createFigmaTokens([CANVAS, semantic], [COLLECTION]);
    const node = { ...boundFrame(), boundVariables: { fills: [alias("v4")], cornerRadius: undefined } } as unknown as FigmaNode;
    const id = tokens.lookup(node).paint("fills", 0);
    expect(tokens.tokens).toHaveLength(1);
    expect(tokens.tokens[0].name).toBe("bg/canvas");
    expect(id).toBe(tokens.tokens[0].id);
  });

  it("binds nothing for a variable the export does not carry", () => {
    const tokens = createFigmaTokens([], [COLLECTION]);
    expect(tokens.lookup(boundFrame()).paint("fills", 0)).toBeUndefined();
    expect(tokens.tokens).toHaveLength(0);
  });

  it("binds the four paddings as one field only when all four name the same variable", () => {
    const tokens = createFigmaTokens([RADIUS], [COLLECTION]);
    const allFour = {
      ...boundFrame(),
      boundVariables: {
        paddingTop: alias("v2"),
        paddingRight: alias("v2"),
        paddingBottom: alias("v2"),
        paddingLeft: alias("v2")
      }
    } as unknown as FigmaNode;
    expect(tokens.lookup(allFour).scalars()).toEqual([{ field: "padding", tokenId: tokens.tokens[0].id }]);

    const three = { ...allFour, boundVariables: { ...allFour.boundVariables, paddingLeft: alias("nope") } } as unknown as FigmaNode;
    expect(tokens.lookup(three).scalars()).toEqual([]);
  });

  it("reuses the document's own token instead of minting a second one", () => {
    const existing: ColorToken = {
      id: "tok_existing",
      name: "bg/canvas",
      type: "color",
      value: "#FFFFFF"
    };
    const tokens = createFigmaTokens([CANVAS], [COLLECTION], { tokens: [existing] });
    expect(tokens.lookup(boundFrame()).paint("fills", 0)).toBe("tok_existing");
    expect(tokens.tokens).toHaveLength(0);
  });

  /**
   * The alias list is indexed by Figma's paint array, which still holds the
   * invisible layers the mapper drops, so the binding has to be lined up on what
   * is DRAWN rather than on what Figma listed.
   */
  it("lines a paint alias up with the drawn paint, past an invisible one", () => {
    const tokens = createFigmaTokens([CANVAS], [COLLECTION]);
    const node = {
      ...boundFrame([{ ...solid(0, 0, 0), visible: false }, solid(1, 1, 1)]),
      boundVariables: { fills: [null, alias("v1")] }
    } as unknown as FigmaNode;
    expect(tokens.lookup(node).paint("fills", 0)).toBe(tokens.tokens[0].id);
    expect(tokens.lookup(node).paint("fills", 1)).toBeUndefined();
  });
});

describe("mapFigmaNode", () => {
  it("writes the token onto the fill and the radius binding onto the element", () => {
    const state = stateWith([CANVAS, RADIUS]);
    const el = mapFigmaNode(boundFrame(), 0, 0, state) as unknown as Record<string, unknown>;
    const fills = el.fills as Array<{ tokenId?: string }>;
    expect(fills[0].tokenId).toBe(state.tokens?.tokens[0].id);
    expect(el.borderRadius).toBe(12);
    expect(el.tokenBindings).toEqual({ borderRadius: state.tokens?.tokens[1].id });
  });

  it("leaves a layer with no bindings exactly as it mapped before", () => {
    const state = stateWith([CANVAS, RADIUS]);
    const plain = { ...boundFrame(), boundVariables: undefined } as unknown as FigmaNode;
    const el = mapFigmaNode(plain, 0, 0, state) as unknown as Record<string, unknown>;
    expect((el.fills as Array<{ tokenId?: string }>)[0].tokenId).toBeUndefined();
    expect(el.tokenBindings).toBeUndefined();
  });
});

describe("importFigmaFile", () => {
  const file = (node: FigmaNode): FigmaFileResponse =>
    ({
      name: "Tokens",
      document: { id: "0:0", name: "Doc", type: "DOCUMENT", children: [{ id: "0:1", name: "Page", type: "CANVAS", children: [node] }] },
      variables: [CANVAS, RADIUS],
      variableCollections: [COLLECTION]
    }) as unknown as FigmaFileResponse;

  it("returns the tokens it minted and counts what it bound", async () => {
    const result = await importFigmaFile(file(boundFrame()));
    expect(result.tokens?.tokens).toHaveLength(2);
    expect(result.tokens?.modes).toEqual([{ id: "dark", name: "Dark" }]);
    expect(result.tokens?.numberModes).toBeUndefined();
    expect(result.report.tokensCreated).toBe(2);
    expect(result.report.tokenBindings).toBe(2);
  });

  /**
   * The whole plugin door, in one go: the shim writes the envelope, the app
   * unwraps it, and the variables that came out of Figma reach the mapper. A
   * token that survives both halves is the only evidence the two agree.
   */
  it("carries variables from the plugin's own envelope through to the mapper", async () => {
    const buildExport = loadCollect().buildExport as unknown as (
      groups: unknown[],
      meta: Record<string, unknown>
    ) => Record<string, unknown>;
    const envelope = buildExport([{ id: "0:1", name: "Page", nodes: [boundFrame()] }], {
      variables: [CANVAS, RADIUS],
      variableCollections: [COLLECTION],
      documentName: "Tokens"
    });

    const parsed = parseFigmaExport(envelope);
    expect(parsed.variables).toHaveLength(2);

    const result = await importFigmaFile({
      document: parsed.document,
      variables: parsed.variables,
      variableCollections: parsed.variableCollections
    });
    expect(result.report.tokensCreated).toBe(2);
    expect(result.report.tokenBindings).toBe(2);
    const frame = result.elements[0] as unknown as { fills: Array<{ tokenId?: string }>; tokenBindings?: Record<string, string> };
    expect(frame.fills[0].tokenId).toBe(result.tokens?.tokens[0].id);
    expect(frame.tokenBindings?.borderRadius).toBe(result.tokens?.tokens[1].id);
  });

  it("mints nothing when the payload carries no variables", async () => {
    const bare = ({
      name: "Tokens",
      document: { id: "0:0", name: "Doc", type: "DOCUMENT", children: [{ id: "0:1", name: "Page", type: "CANVAS", children: [boundFrame()] }] }
    }) as unknown as FigmaFileResponse;
    const result = await importFigmaFile(bare);
    expect(result.tokens).toBeUndefined();
    expect(result.report.tokensCreated).toBe(0);
  });
});

describe("the plugin's shim", () => {
  it("carries a node's bindings and the file's variables through the envelope", () => {
    const buildExport = loadCollect().buildExport as unknown as (
      groups: unknown[],
      meta: Record<string, unknown>
    ) => Record<string, unknown>;
    const envelope = buildExport(
      [{ id: "0:1", name: "Page", nodes: [boundFrame()] }],
      { variables: [CANVAS], variableCollections: [COLLECTION] }
    ) as unknown as { document: { children: Array<{ children: FigmaNode[] }> }; variables?: FigmaVariable[] };
    expect(envelope.variables).toHaveLength(1);
    // Positions survive: a null where a paint is not bound is what lets the app
    // line the second binding up with the second paint.
    expect(envelope.document.children[0].children[0].boundVariables?.fills).toEqual([alias("v1")]);
    expect(envelope.document.children[0].children[0].boundVariables?.cornerRadius).toEqual(alias("v2"));
  });

  it("carries no variables key when the file has none, so the app binds nothing", () => {
    const buildExport = loadCollect().buildExport as unknown as (
      groups: unknown[],
      meta: Record<string, unknown>
    ) => Record<string, unknown>;
    const envelope = buildExport([{ id: "0:1", name: "Page", nodes: [boundFrame()] }], {});
    expect(envelope.variables).toBeUndefined();
  });
});

describe("categoryOf", () => {
  it("reads the family out of the variable's name, because Figma says only FLOAT", () => {
    expect(categoryOf("radius/card")).toBe("radius");
    expect(categoryOf("space/md")).toBe("spacing");
    expect(categoryOf("font/body")).toBe("typography");
    expect(categoryOf("border/hairline")).toBe("stroke");
    expect(categoryOf("shadow/card")).toBe("effect");
    expect(categoryOf("size/sidebar")).toBe("size");
  });
});

import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { normalizeTokenColor } from "../src/core/dsl/normalize/tokens";
import schema from "../src/core/dsl/fish.schema.json";
import { parseLenientJson } from "../src/core/dsl/lenient-json";
import { validateTokenRefs } from "../src/core/validate-tokens";
import type { DesignDocument } from "../src/core/dsl/types";

/**
 * `doc.tokens[]` is the value table beside `doc.styles[]`. Normalization runs on
 * every load AND every save, so a token the reader forgets is a token the user
 * cannot keep — and one it keeps without validating is a token every reader then
 * has to re-check.
 */

const doc = (tokens: unknown, extra: Record<string, unknown> = {}) => ({
  version: "0.1",
  name: "Tokens",
  canvas: { width: 100, height: 100, background: { type: "solid", color: "#FFFFFF" } },
  pages: [{ id: "p1", name: "P1", children: [] }],
  tokens,
  ...extra
});

/** Normalizing twice must reach a fixed point, or a save keeps mutating the file. */
const twice = (input: unknown) => {
  const first = normalizeDesignDocument(input);
  const second = normalizeDesignDocument(first.document);
  return { first, second };
};

describe("normalizeTokens", () => {
  it("keeps a colour token and a number token, with a fixed point", () => {
    const { first, second } = twice(
      doc([
        { id: "tok_surface", name: "color/surface", type: "color", value: "#FFFFFF" },
        { id: "tok_radius", name: "radius/card", type: "number", value: 12, category: "radius" }
      ])
    );
    expect(first.document.tokens).toEqual([
      { id: "tok_surface", name: "color/surface", type: "color", value: "#ffffff" },
      { id: "tok_radius", name: "radius/card", type: "number", value: 12, category: "radius" }
    ]);
    expect(second.document.tokens).toEqual(first.document.tokens);
    expect(second.repairs).toEqual([]);
  });

  it("keeps an 8-digit hex, which is the only encoding for alpha", () => {
    const { first } = twice(doc([{ id: "tok_scrim", name: "color/scrim", type: "color", value: "#00000066" }]));
    expect(first.document.tokens).toEqual([
      { id: "tok_scrim", name: "color/scrim", type: "color", value: "#00000066" }
    ]);
    expect(first.repairs).toEqual([]);
  });

  it("accepts 3-digit hex and transparent", () => {
    const { first } = twice(
      doc([
        { id: "a", name: "a", type: "color", value: "#F00" },
        { id: "b", name: "b", type: "color", value: "transparent" }
      ])
    );
    expect(first.document.tokens?.map((t) => (t as { value: string }).value)).toEqual(["#f00", "transparent"]);
  });

  it("keeps every mode value and the mode list beside it", () => {
    const { first, second } = twice(
      doc(
        [
          {
            id: "tok_surface",
            name: "color/surface",
            type: "color",
            value: "#FFFFFF",
            modes: { dark: "#0A0A0A" }
          },
          { id: "tok_gap", name: "space/md", type: "number", value: 16, modes: { dark: 20 } }
        ],
        { modes: [{ id: "dark", name: "Dark" }], activeTheme: "dark" }
      )
    );
    const [surface, gap] = first.document.tokens ?? [];
    expect(surface.modes).toEqual({ dark: "#0a0a0a" });
    expect(gap.modes).toEqual({ dark: 20 });
    expect(second.document.tokens).toEqual(first.document.tokens);
    expect(first.repairs).toEqual([]);
  });

  it("drops a colour value that is not 3/6/8-digit hex, and says so", () => {
    const { first } = twice(
      doc([
        { id: "tok_ok", name: "ok", type: "color", value: "#123456" },
        { id: "tok_rgba", name: "rgba", type: "color", value: "#12345678f" },
        { id: "tok_short", name: "short-alpha", type: "color", value: "#1234" },
        { id: "tok_named", name: "named", type: "color", value: "red" },
        { id: "tok_num", name: "number-as-colour", type: "color", value: 7 }
      ])
    );
    expect(first.document.tokens?.map((t) => t.id)).toEqual(["tok_ok"]);
    const paths = first.repairs.filter((r) => r.path.startsWith("/tokens/")).map((r) => r.path);
    expect(paths).toEqual(["/tokens/1/value", "/tokens/2/value", "/tokens/3/value", "/tokens/4/value"]);
    expect(first.repairs.every((r) => r.severity === undefined)).toBe(true);
  });

  it("drops a number value that is not finite, and says so", () => {
    const { first } = twice(
      doc([
        { id: "ok", name: "ok", type: "number", value: 0 },
        { id: "str", name: "string", type: "number", value: "12px" },
        { id: "inf", name: "infinite", type: "number", value: Infinity }
      ])
    );
    expect(first.document.tokens).toEqual([{ id: "ok", name: "ok", type: "number", value: 0 }]);
    expect(first.repairs.map((r) => r.path)).toEqual(["/tokens/1/value", "/tokens/2/value"]);
  });

  it("drops an entry with no type, naming the legacy `number` style it probably was", () => {
    const { first } = twice(
      doc([
        { id: "legacy", name: "space/md", styleType: "number", value: 16 },
        { id: "single-solid", name: "surface", styleType: "paint", paints: [{ type: "solid", color: "#FFF" }] }
      ])
    );
    expect(first.document.tokens).toBeUndefined();
    expect(first.repairs.map((r) => r.path)).toEqual(["/tokens/0/type", "/tokens/1/type"]);
  });

  it("drops a mode value of the wrong type but keeps the rest of the token", () => {
    const { first } = twice(
      doc(
        [{ id: "tok_a", name: "a", type: "color", value: "#FFFFFF", modes: { dark: "#000000", dim: "nope" } }],
        { modes: [{ id: "dark", name: "Dark" }, { id: "dim", name: "Dim" }] }
      )
    );
    expect(first.document.tokens?.[0].modes).toEqual({ dark: "#000000" });
    expect(first.repairs.map((r) => r.path)).toEqual(["/tokens/0/modes/dim"]);
  });

  it("mints `tok_<n>` ids for unnamed entries and defaults the name to the id", () => {
    const { first } = twice(doc([{ type: "color", value: "#FFFFFF" }, { id: "tok_radius", type: "number", value: 4 }]));
    expect(first.document.tokens).toEqual([
      { id: "tok_1", name: "tok_1", type: "color", value: "#ffffff" },
      { id: "tok_radius", name: "tok_radius", type: "number", value: 4 }
    ]);
  });

  it("keeps the first of two entries sharing an id", () => {
    const { first } = twice(
      doc([
        { id: "same", name: "first", type: "number", value: 1 },
        { id: "same", name: "second", type: "number", value: 2 }
      ])
    );
    expect(first.document.tokens).toEqual([{ id: "same", name: "first", type: "number", value: 1 }]);
    expect(first.repairs.map((r) => r.path)).toEqual(["/tokens/1/id"]);
  });

  it("ignores a category the vocabulary does not publish rather than keeping it", () => {
    const { first } = twice(doc([{ id: "t", name: "t", type: "number", value: 2, category: "weird" }]));
    expect(first.document.tokens).toEqual([{ id: "t", name: "t", type: "number", value: 2 }]);
  });

  it("round-trips through the writer, because an exported token is a loadable token", () => {
    const { first } = twice(
      doc([
        { id: "tok_surface", name: "color/surface", type: "color", value: "#FFFFFF", modes: { dark: "#0A0A0A" } },
        { id: "tok_radius", name: "radius/card", type: "number", value: 12, category: "radius" }
      ], { modes: [{ id: "dark", name: "Dark" }] })
    );
    const reloaded = normalizeDesignDocument(JSON.parse(JSON.stringify(first.document)));
    expect(reloaded.document.tokens).toEqual(first.document.tokens);
    expect(reloaded.repairs).toEqual([]);
  });
});

describe("normalizeTokenColor", () => {
  it("is the one rule for a colour value", () => {
    expect(normalizeTokenColor("#FFF")).toBe("#fff");
    expect(normalizeTokenColor("ffffff")).toBe("#ffffff");
    expect(normalizeTokenColor("#00000066")).toBe("#00000066");
    expect(normalizeTokenColor("TRANSPARENT")).toBe("transparent");
    expect(normalizeTokenColor("#1234")).toBeUndefined();
    expect(normalizeTokenColor("rgb(0 0 0)")).toBeUndefined();
    expect(normalizeTokenColor(12)).toBeUndefined();
  });
});

describe("fish.schema.json declares the token table", () => {
  it("publishes `tokens` beside `styles`", () => {
    expect(schema.properties.tokens.items.$ref).toBe("#/definitions/DesignToken");
  });

  it("splits DesignToken into the two value shapes the engine reads", () => {
    const variants = schema.definitions.DesignToken.oneOf;
    expect(variants).toHaveLength(2);
    expect(variants.map((v) => v.properties.type.enum[0])).toEqual(["color", "number"]);
    // Colours go through a named pattern so the 3/6/8-digit rule has one home.
    expect(variants[0].properties.value.$ref).toBe("#/definitions/TokenColor");
    expect(schema.definitions.TokenColor.type).toBe("string");
    expect(variants[1].properties.value.type).toBe("number");
  });
});

/**
 * Step 1's exit criterion, spelled as the reader `fish check` uses: a document
 * an author hand-wrote in the new shape must normalize without losing anything,
 * and must not be reported as having a broken reference.
 */
describe("a hand-written token document", () => {
  const SOURCE = `{
    "version": "0.1",
    "name": "Hand-written",
    "canvas": { "width": 400, "height": 300, "background": { "type": "solid", "color": "#FFFFFF" } },
    "modes": [{ "id": "dark", "name": "Dark" }],
    "activeTheme": "dark",
    "tokens": [
      { "id": "tok_surface", "name": "color/surface", "type": "color", "value": "#FFFFFF",
        "modes": { "dark": "#0A0A0A" } },
      { "id": "tok_scrim", "name": "color/scrim", "type": "color", "value": "#00000066" },
      { "id": "tok_radius", "name": "radius/card", "type": "number", "value": 12, "category": "radius" }
    ],
    "styles": [
      { "id": "style_card", "name": "surface/card", "styleType": "paint",
        "paints": [{ "type": "solid", "color": "#FFFFFF", "tokenId": "tok_surface" }] }
    ],
    "pages": [
      { "id": "p1", "name": "Page 1", "children": [
        { "id": "card", "type": "rect", "name": "Card", "x": 0, "y": 0, "width": 200, "height": 120,
          "fills": [{ "type": "solid", "color": "#FFFFFF", "tokenId": "tok_surface" }],
          "tokenBindings": { "borderRadius": "tok_radius" }, "fillStyleId": "style_card" }
      ] }
    ]
  }`;

  it("normalizes with zero repairs", () => {
    const { document, repairs } = normalizeDesignDocument(parseLenientJson(SOURCE));
    expect(repairs).toEqual([]);
    expect(document.tokens).toHaveLength(3);
  });

  it("checks clean against the reference rules", () => {
    const { document } = normalizeDesignDocument(parseLenientJson(SOURCE));
    expect(validateTokenRefs(document as DesignDocument)).toEqual([]);
  });

  it("keeps its style table untouched, because step 1 adds a table rather than moving one", () => {
    const { document } = normalizeDesignDocument(parseLenientJson(SOURCE));
    expect(document.styles?.map((s) => s.id)).toEqual(["style_card"]);
  });
});

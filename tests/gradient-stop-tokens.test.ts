import { describe, expect, it } from "vitest";
import { canonicalGradientStops, materializeStopTokens } from "../src/core/dsl/gradient-stops";
import { normalizePaint } from "../src/core/dsl/normalize/paint";
import { cascadeTokensIntoStyles, syncDualStorage } from "../src/core/interactions/style-sync";
import { countTokenUses } from "../src/core/interactions/token-ops";
import { removeTokenFromDoc } from "../src/core/interactions/style-ops";
import { switchDocumentTheme } from "../src/core/interactions/mode-ops";
import { validateTokenRefs } from "../src/core/validate-tokens";
import type {
  ColorToken,
  DesignDocument,
  DesignElement,
  DesignStyle,
  Paint
} from "../src/core/dsl/types";

type LinearRamp = Extract<Paint, { type: "linear-gradient" }>;

const INK: ColorToken = {
  id: "tok_ink",
  name: "ink/primary",
  type: "color",
  value: "#111111",
  modes: { dark: "#EEEEEE" }
};

const ramp = (
  stops: LinearRamp["stops"],
  extra: Partial<LinearRamp> = {}
): LinearRamp => ({
  type: "linear-gradient",
  angle: 90,
  from: stops?.[0]?.color ?? "#111111",
  to: stops?.[stops.length - 1]?.color ?? "#222222",
  stops,
  ...extra
});

const card = (paint: LinearRamp): DesignElement =>
  ({
    id: "card",
    name: "Card",
    type: "rect",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fills: [paint]
  }) as unknown as DesignElement;

const docWith = (elements: DesignElement[], extra: Partial<DesignDocument> = {}): DesignDocument =>
  ({
    version: "0.1",
    name: "Ramp",
    canvas: { width: 100, height: 100 },
    pages: [{ id: "page_1", name: "Page 1", canvas: { width: 100, height: 100 }, children: elements }],
    activePageId: "page_1",
    ...extra
  }) as unknown as DesignDocument;

describe("a stop's token survives normalization", () => {
  it("keeps tokenId without carrying the alias it was written with", () => {
    expect(
      canonicalGradientStops([
        { position: 0, color: "#000000", tokenId: "tok_ink" },
        { offset: 1, color: "#FFFFFF" }
      ])
    ).toEqual([
      { color: "#000000", offset: 0, tokenId: "tok_ink" },
      { color: "#FFFFFF", offset: 1 }
    ]);
  });

  it("keeps a ramp whose two stops follow different tokens of the same colour", () => {
    const paint = normalizePaint({
      type: "linear-gradient",
      stops: [
        { offset: 0, color: "#FFFFFF", tokenId: "tok_surface" },
        { offset: 1, color: "#FFFFFF", tokenId: "tok_raised" }
      ]
    });
    expect(paint?.type).toBe("linear-gradient");
    if (paint?.type === "linear-gradient") {
      expect(paint.stops?.map((s) => s.tokenId)).toEqual(["tok_surface", "tok_raised"]);
    }
  });

  it("collapses a ramp bound to one token into a solid that keeps the token", () => {
    const paint = normalizePaint({
      type: "linear-gradient",
      stops: [
        { offset: 0, color: "#FFFFFF", tokenId: "tok_surface" },
        { offset: 1, color: "#FFFFFF", tokenId: "tok_surface" }
      ]
    });
    expect(paint).toMatchObject({ type: "solid", color: "#FFFFFF", tokenId: "tok_surface" });
  });
});

describe("materializeStopTokens", () => {
  it("rewrites only the stops that follow a token", () => {
    const stops = [
      { color: "#111111", offset: 0, tokenId: "tok_ink" },
      { color: "#222222", offset: 1 }
    ];
    expect(materializeStopTokens(stops, (id) => (id === "tok_ink" ? "#EEEEEE" : undefined))).toEqual([
      { color: "#EEEEEE", offset: 0, tokenId: "tok_ink" },
      { color: "#222222", offset: 1 }
    ]);
  });

  it("reports nothing to do when the token already matches", () => {
    const stops = [{ color: "#111111", offset: 0, tokenId: "tok_ink" }];
    expect(materializeStopTokens(stops, () => "#111111")).toBeUndefined();
    expect(materializeStopTokens(stops, () => undefined)).toBeUndefined();
  });
});

describe("token edits reach a gradient's stops", () => {
  it("moves the bound stop and the endpoint it mirrors", () => {
    const el = card(
      ramp([
        { offset: 0, color: "#111111", tokenId: "tok_ink" },
        { offset: 1, color: "#222222" }
      ])
    );
    const next = syncDualStorage(el, { tokens: [INK], styles: [] }, "dark");
    const paint = next.fills?.[0];
    expect(paint?.type).toBe("linear-gradient");
    if (paint?.type === "linear-gradient") {
      expect(paint.stops?.[0].color).toBe("#EEEEEE");
      expect(paint.from).toBe("#EEEEEE");
      expect(paint.to).toBe("#222222");
    }
  });

  it("repaints the stops when the document switches mode", () => {
    const el = card(
      ramp([
        { offset: 0, color: "#111111", tokenId: "tok_ink" },
        { offset: 1, color: "#222222" }
      ])
    );
    const doc = docWith([el], {
      tokens: [INK],
      modes: [{ id: "default", name: "Default" }, { id: "dark", name: "Dark" }]
    });
    const paint = switchDocumentTheme(doc, "dark").pages?.[0].children[0].fills?.[0];
    expect(paint?.type).toBe("linear-gradient");
    if (paint?.type === "linear-gradient") {
      expect(paint.stops?.[0].color).toBe("#EEEEEE");
      expect(paint.from).toBe("#EEEEEE");
    }
  });

  it("cascades into a paint style's stops before any layer wears it", () => {
    const style: DesignStyle = {
      id: "st_ramp",
      name: "Ramp",
      styleType: "paint",
      paints: [
        ramp([
          { offset: 0, color: "#111111", tokenId: "tok_ink" },
          { offset: 1, color: "#222222" }
        ])
      ]
    };
    const [next] = cascadeTokensIntoStyles([style], [INK], "dark");
    const paint = next.styleType === "paint" ? next.paints[0] : undefined;
    expect(paint?.type).toBe("linear-gradient");
    if (paint?.type === "linear-gradient") {
      expect(paint.stops?.[0].color).toBe("#EEEEEE");
      expect(paint.from).toBe("#EEEEEE");
    }
  });
});

describe("a stop's token is a reference like any other", () => {
  it("names the stop and the layer when the token is missing", () => {
    const el = card(
      ramp([
        { offset: 0, color: "#111111" },
        { offset: 1, color: "#222222", tokenId: "tok_gone" }
      ])
    );
    const [gap] = validateTokenRefs(docWith([el]));
    expect(gap.level).toBe("warning");
    expect(gap.elementId).toBe("card");
    expect(gap.message).toContain('"tok_gone"');
    expect(gap.message).toContain("Fill 1 stop 2");
  });

  it("counts as a use of the token", () => {
    const el = card(
      ramp([
        { offset: 0, color: "#111111", tokenId: "tok_ink" },
        { offset: 1, color: "#222222" }
      ])
    );
    expect(countTokenUses(docWith([el], { tokens: [INK] }), "tok_ink")).toBe(1);
  });

  it("is cleared when the token is deleted, leaving the colour it was showing", () => {
    const el = card(
      ramp([
        { offset: 0, color: "#111111", tokenId: "tok_ink" },
        { offset: 1, color: "#222222" }
      ])
    );
    const next = removeTokenFromDoc(docWith([el], { tokens: [INK] }), "tok_ink");
    const paint = next.pages?.[0].children[0].fills?.[0];
    expect(paint?.type).toBe("linear-gradient");
    if (paint?.type === "linear-gradient") {
      expect(paint.stops?.[0]).toEqual({ color: "#111111", offset: 0 });
    }
  });
});

/**
 * An override is a stored VALUE, and a token inside it is a reference like any
 * other — so switching modes has to reach it too. Only the solid's own `tokenId`
 * used to be synced, which left an overridden ramp (and every overridden stroke
 * and shadow) painted in the mode it was written in while the rest of the page
 * changed around it.
 */
describe("a token inside an instance override follows the mode", () => {
  const inst = (overrides: unknown[]): DesignElement =>
    ({
      id: "inst",
      name: "INST",
      type: "instance",
      componentId: "card",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      overrides
    }) as unknown as DesignElement;

  const synced = (elements: DesignElement[]): any =>
    syncDualStorage(elements[0], { tokens: [INK], styles: [] }, "dark");

  it("re-materialises a gradient stop", () => {
    const overrides = [
      {
        targetId: "card",
        property: "fills",
        value: [ramp([{ offset: 0, color: "#111111", tokenId: "tok_ink" }, { offset: 1, color: "#222222" }])]
      }
    ];
    const paint = synced([inst(overrides)]).overrides[0].value[0] as LinearRamp;
    expect(paint.stops?.[0].color).toBe("#EEEEEE");
    // The mirrored endpoints follow the stops they mirror.
    expect(paint.from).toBe("#EEEEEE");
    expect(paint.stops?.[1].color).toBe("#222222");
  });

  it("re-materialises a stroke's colour", () => {
    const overrides = [
      { targetId: "card", property: "strokes", value: [{ width: 1, color: "#111111", tokenId: "tok_ink", align: "inside" }] }
    ];
    const strokes = synced([inst(overrides)]).overrides[0].value;
    expect(strokes[0].color).toBe("#EEEEEE");
    expect(strokes[0].width).toBe(1);
  });

  it("re-materialises a drop shadow's tint", () => {
    const overrides = [
      {
        targetId: "card",
        property: "effects",
        value: [{ type: "drop-shadow", blur: 4, offset: { x: 0, y: 2 }, color: "#111111", tokenId: "tok_ink" }]
      }
    ];
    const effects = synced([inst(overrides)]).overrides[0].value;
    expect(effects[0].color).toBe("#EEEEEE");
    expect(effects[0].blur).toBe(4);
  });

  it("moves the number a binding stands for along with the binding", () => {
    const radius = { id: "tok_radius", name: "radius/md", type: "number" as const, value: 8, modes: { dark: 16 } };
    const el = syncDualStorage(
      inst([
        { targetId: "card", property: "tokenBindings", value: { borderRadius: "tok_radius" } },
        { targetId: "card", property: "borderRadius", value: 8 }
      ]),
      { tokens: [radius], styles: [] },
      "dark"
    ) as any;
    expect(el.overrides.find((o: any) => o.property === "borderRadius").value).toBe(16);
  });
});

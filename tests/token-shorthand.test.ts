import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { documentToPlainObject } from "../src/core/document-json";
import { getActivePage } from "../src/core/dsl/document-ops";
import { applyOps } from "../src/core/ops/apply-ops";
import { checkVerdict } from "../src/core/check-verdict";
import { TOKEN_SHORTHAND_BINDINGS, TOKEN_SHORTHAND_KEYS, parseTokenRef } from "../src/core/dsl/normalize/token-shorthand";
import { bindNumberTokenToElement, unbindNumberTokenFromElement } from "../src/core/interactions/number-token-ops";
import { syncDualStorage } from "../src/core/interactions/style-sync";
import { layoutOf } from "../src/core/dsl/layout-flat";
import type { DesignElement } from "../src/core/dsl/types";

/**
 * `$token` shorthands: the author writes a name, the engine writes the stored
 * pair (reference + value).
 *
 * The point of the feature is that an AGENT can author a themed document — it
 * cannot read an id out of a file and it cannot click a token picker — so what
 * these grade is not "the string was accepted" but "the layer the engine ends up
 * with equals the one the inspector would have produced". A shorthand that lands
 * a different shape is worse than no shorthand: it is a second writer.
 *
 * The slot cases are DERIVED from `TOKEN_SHORTHAND_KEYS` (AGENTS.md §5.1): a slot
 * added to the table without a case here is a slot nothing grades, and a list
 * copied by hand cannot report that.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

const COLOR_TOKENS = [
  { id: "tok_surface", name: "color/surface", type: "color", value: "#F7F7F7" },
  { id: "tok_ink", name: "color/ink", type: "color", value: "#111111" }
];

const NUMBER_TOKENS = [
  { id: "tok_space", name: "space/md", type: "number", value: 16, category: "spacing" },
  { id: "tok_radius", name: "radius/card", type: "number", value: 12, category: "radius" },
  { id: "tok_stroke", name: "stroke/thin", type: "number", value: 2, category: "stroke" },
  { id: "tok_type", name: "type/body", type: "number", value: 14, category: "typography" }
];

const tokens = [...COLOR_TOKENS, ...NUMBER_TOKENS];

const doc = (children: unknown[], extra: Record<string, unknown> = {}) => ({
  version: "0.1",
  name: "Shorthand",
  canvas: { width: 200, height: 200, background: { type: "solid", color: "#FFFFFF" } },
  pages: [{ id: "p1", name: "P1", children }],
  tokens,
  ...extra
});

const normalize = (children: unknown[], extra: Record<string, unknown> = {}) =>
  normalizeDesignDocument(doc(children, extra));

/** The first normalized child, plus every repair this pass raised. */
const only = (children: unknown[], extra: Record<string, unknown> = {}) => {
  const { document, repairs } = normalize(children, extra);
  return {
    element: document.pages![0].children![0] as Record<string, any>,
    tokenRepairs: repairs.filter((repair) => repair.kind === "token")
  };
};

/** A layout container that every number slot can live on. */
const frame = (extra: Record<string, unknown>) => ({ id: "card", type: "frame", display: "flex", ...extra });

describe("parseTokenRef", () => {
  it("reads the three spellings and refuses anything else", () => {
    expect(parseTokenRef("$color/surface")).toBe("color/surface");
    expect(parseTokenRef(" $color-surface ")).toBe("color-surface");
    expect(parseTokenRef("$tok_surface")).toBe("tok_surface");
    expect(parseTokenRef("var(--color)")).toBeNull();
    expect(parseTokenRef("$")).toBeNull();
    expect(parseTokenRef("#FFFFFF")).toBeNull();
    expect(parseTokenRef(8)).toBeNull();
  });
});

describe("colour slots", () => {
  // `color` is folded into `style.color` on a text layer and into `fills` on
  // everything else; both roads end on the same paint.
  const COLOR_CASES: Array<{ key: string; element: Record<string, unknown> }> = [
    { key: "background", element: { id: "e", type: "rect" } },
    { key: "background-color", element: { id: "e", type: "rect" } },
    { key: "backgroundColor", element: { id: "e", type: "rect" } },
    { key: "color", element: { id: "e", type: "text", content: "Hi" } }
  ];

  for (const { key, element } of COLOR_CASES) {
    it(`lowers "${key}" onto a solid paint that names and shows the token`, () => {
      const { element: out } = only([{ ...element, [key]: "$color/surface" }]);
      // Lower-cased hex: a token's value is a value, not a spelling, and the
      // paint must carry exactly what the table holds.
      expect(out.fills).toEqual([{ type: "solid", color: "#f7f7f7", tokenId: "tok_surface" }]);
      expect(out[key]).toBeUndefined();
    });
  }

  it("keeps a text layer's style.color on the same colour as its fill", () => {
    const { element: out } = only([{ id: "e", type: "text", content: "Hi", color: "$color/ink" }]);
    expect(out.fills).toEqual([{ type: "solid", color: "#111111", tokenId: "tok_ink" }]);
    expect(out.style?.color).toBe("#111111");
  });

  it("binds a colour named inside a paint stack entry", () => {
    const { element: out } = only([
      { id: "e", type: "rect", fills: [{ type: "solid", color: "$color/ink" }] }
    ]);
    expect(out.fills).toEqual([{ type: "solid", color: "#111111", tokenId: "tok_ink" }]);
  });

  it("binds a stroke colour through the structured border, keeping the CSS alignment", () => {
    const { element: out } = only([{ id: "e", type: "rect", borderColor: "$color/ink" }]);
    expect(out.strokes).toEqual([
      { color: "#111111", width: 1, style: "solid", align: "inside", tokenId: "tok_ink" }
    ]);
  });

  it("refuses a colour alias when fills is already set, and says so", () => {
    const { element: out, tokenRepairs } = only([
      { id: "e", type: "rect", fills: [{ type: "solid", color: "#000000" }], background: "$color/ink" }
    ]);
    expect(out.fills).toEqual([{ type: "solid", color: "#000000" }]);
    expect(tokenRepairs.map((repair) => repair.path)).toEqual(["/pages/0/children/0/background"]);
    expect(tokenRepairs[0].message).toContain("fills is already set");
  });

  it("lowers a border shorthand that carries a token colour, keeping width and style", () => {
    const { element: out } = only([{ id: "e", type: "rect", border: "2px dashed $color/ink" }]);
    expect(out.border).toBeUndefined();
    expect(out.strokes).toEqual([
      { color: "#111111", width: 2, style: "dashed", align: "inside", dashArray: [6, 4], tokenId: "tok_ink" }
    ]);
  });

  it("refuses a token inside a per-side border, which has one colour for all four", () => {
    const { tokenRepairs } = only([{ id: "e", type: "rect", "border-top": "1px solid $color/ink" }]);
    expect(tokenRepairs.length).toBe(1);
    expect(tokenRepairs[0].path).toBe("/pages/0/children/0/border-top");
    expect(tokenRepairs[0].message).toContain("one colour covers every side");
  });

  it("refuses a token inside a box-shadow string, which lands on an effect", () => {
    const { tokenRepairs } = only([
      { id: "e", type: "rect", boxShadow: "0 4px 12px $color/ink" }
    ]);
    expect(tokenRepairs.length).toBe(1);
    expect(tokenRepairs[0].path).toBe("/pages/0/children/0/boxShadow");
    expect(tokenRepairs[0].message).toContain("effects[] entry");
  });

  it("resolves the existing tokenId field by NAME, which is the documented spelling", () => {
    const { element: out } = only([
      { id: "e", type: "rect", fills: [{ type: "solid", color: "#111111", tokenId: "color/ink" }] }
    ]);
    expect(out.fills).toEqual([{ type: "solid", color: "#111111", tokenId: "tok_ink" }]);
  });
});

describe("number slots", () => {
  // Derived from the table: a key added there without a case here fails this
  // loop's own coverage assertion below.
  const covered = new Set<string>();

  for (const key of TOKEN_SHORTHAND_KEYS.number) {
    it(`binds "${key}" and writes the value beside it`, () => {
      covered.add(key);
      const isType = ["font-size", "line-height", "letter-spacing"].includes(key);
      const element = isType
        ? { id: "e", type: "text", content: "Hi", [key]: "$type/body" }
        : frame({ [key]: "$space/md" });
      const { element: out } = only([element]);

      const bound = Object.keys(out.tokenBindings ?? {});
      expect(bound.length, `${key} recorded exactly one binding`).toBe(1);
      const prop = bound[0];
      expect(out.tokenBindings![prop]).toBe(isType ? "tok_type" : "tok_space");

      // …and the value is materialised, not left as a placeholder.
      if (prop === "fontSize") expect(out.style.fontSize).toBe(14);
      else if (prop === "lineHeight") expect(out.style.lineHeight).toBe("14px");
      else if (prop === "letterSpacing") expect(out.style.letterSpacing).toBe(14);
      else if (prop === "strokeWidth") expect(out.strokes?.[0]?.width).toBe(16);
      else if (prop === "borderRadius" || prop.endsWith("Radius")) expect(out.borderRadius).toBeDefined();
      else expect(out[prop]).toBe(16);

      // The author's spelling is gone: one statement, one slot. (A slot whose
      // stored property is the key itself now holds the value, not the ref.)
      expect(String(out[key] ?? "")).not.toMatch(/^\$/);
    });
  }

  it("grades every slot in the table", () => {
    for (const key of TOKEN_SHORTHAND_KEYS.number) {
      expect(TOKEN_SHORTHAND_BINDINGS[key], `${key} names a stored property`).toBeTruthy();
    }
  });

  it("moves the whole radius tuple for a corner binding, and only that corner", () => {
    const { element: out } = only([frame({ borderRadius: 4, "border-top-left-radius": "$radius/card" })]);
    expect(out.borderRadius).toEqual([12, 4, 4, 4]);
    expect(out.tokenBindings).toEqual({ borderTopLeftRadius: "tok_radius" });
  });

  it("moves every stroke row for a stroke width binding", () => {
    const { element: out } = only([
      frame({
        strokes: [
          { color: "#000000", width: 1 },
          { color: "#FFFFFF", width: 3 }
        ],
        strokeWidth: "$stroke/thin"
      })
    ]);
    expect(out.strokes.map((stroke: any) => stroke.width)).toEqual([2, 2]);
    expect(out.tokenBindings).toEqual({ strokeWidth: "tok_stroke" });
  });

  it("is the same layer the inspector's bind command produces", () => {
    // The equivalence the whole feature rests on: one writer, two callers. The
    // inspector writes the value beside the binding, so that is the shape the
    // shorthand has to reach.
    const cases: Array<[string, string, string, number, string]> = [
      ["gap", "gap", "tok_space", 16, "space/md"],
      ["padding", "padding", "tok_space", 16, "space/md"],
      ["border-radius", "borderRadius", "tok_radius", 12, "radius/card"],
      ["stroke-width", "strokeWidth", "tok_stroke", 2, "stroke/thin"]
    ];

    for (const [key, prop, tokenId, value, ref] of cases) {
      const viaShorthand = normalize([frame({ [key]: `$${ref}` })]).document.pages![0].children![0];
      const viaBind = normalize([
        bindNumberTokenToElement(
          frame({ [key]: value }) as unknown as DesignElement,
          prop,
          tokenId,
          value
        ) as unknown as Record<string, unknown>
      ]).document.pages![0].children![0];
      expect(viaShorthand, key).toEqual(viaBind);
    }
  });

  it("materialises a binding that names its token, without touching the pointer", () => {
    const { element: out } = only([frame({ tokenBindings: { gap: "space/md" } })]);
    expect(out.tokenBindings).toEqual({ gap: "tok_space" });
    expect(out.gap).toBe(16);
  });
});

describe("modes", () => {
  const themed = [
    { id: "tok_surface", name: "color/surface", type: "color", value: "#FFFFFF", modes: { dark: "#111111" } }
  ];
  const modes = [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" }
  ];

  it("resolves the token in the document's active mode", () => {
    const { element } = only([{ id: "e", type: "rect", background: "$color/surface" }], {
      tokens: themed,
      modes,
      activeTheme: "dark"
    });
    expect(element.fills).toEqual([{ type: "solid", color: "#111111", tokenId: "tok_surface" }]);
  });

  it("honours a container's own themeMode for its own bindings", () => {
    const { element } = only([{ id: "e", type: "rect", themeMode: "dark", background: "$color/surface" }], {
      tokens: themed,
      modes,
      activeTheme: "light"
    });
    expect(element.fills[0].color).toBe("#111111");
  });

  it("carries a container's themeMode down its subtree", () => {
    const { element } = only(
      [
        {
          id: "outer",
          type: "frame",
          themeMode: "dark",
          children: [{ id: "inner", type: "rect", background: "$color/surface" }]
        }
      ],
      { tokens: themed, modes, activeTheme: "light" }
    );
    expect((element.children[0] as Record<string, any>).fills[0].color).toBe("#111111");
  });
});

describe("a new value replaces the binding it supersedes", () => {
  // The two tokens that make "the old binding" a different answer from the new
  // one; with a single token per slot every one of these cases would pass by
  // coincidence.
  const OTHER = [
    { id: "tok_tight", name: "space/tight", type: "number", value: 4, category: "spacing" },
    { id: "tok_muted", name: "color/muted", type: "color", value: "#999999" }
  ];
  const withOther = { tokens: [...tokens, ...OTHER] };

  it("rebinds a number slot with the NEW token, not the one it was already bound to", () => {
    const { element } = only([frame({ gap: "$space/md", tokenBindings: { gap: "tok_tight" } })], withOther);
    expect(element.gap).toBe(16);
    expect(element.tokenBindings).toEqual({ gap: "tok_space" });
  });

  it("rebinds a paint with the NEW token, not the one its tokenId already names", () => {
    const { element } = only(
      [{ id: "e", type: "rect", fills: [{ type: "solid", color: "$color/ink", tokenId: "tok_muted" }] }],
      withOther
    );
    expect(element.fills).toEqual([{ type: "solid", color: "#111111", tokenId: "tok_ink" }]);
  });

  it("keeps a tokenId that names its token by name, when no new reference is written", () => {
    const { element } = only([
      { id: "e", type: "rect", fills: [{ type: "solid", color: "#999999", tokenId: "color/muted" }] }
    ], withOther);
    expect(element.fills).toEqual([{ type: "solid", color: "#999999", tokenId: "tok_muted" }]);
  });

  const boundCard = () =>
    normalizeDesignDocument(doc([frame({ borderRadius: 12, tokenBindings: { borderRadius: "tok_radius" } })])).document;

  it("unsets the number token a literal patch overwrites", () => {
    // Without the cleanup the merge writes 20, then the shorthand pass replays
    // the binding and puts 12 back — a patch that reports success and paints
    // the old value.
    const result = applyOps(boundCard(), [{ op: "patch", targetId: "card", props: { "border-radius": 20 } }]);
    expect(result.outcomes[0]).toMatchObject({ ok: true });
    const card = getActivePage(result.doc).children[0] as Record<string, any>;
    expect(card.borderRadius).toBe(20);
    expect(card.tokenBindings).toBeUndefined();
  });

  it("rebinds rather than unsets when the patch names a token", () => {
    const result = applyOps(boundCard(), [{ op: "patch", targetId: "card", props: { "border-radius": "$space/md" } }]);
    const card = getActivePage(result.doc).children[0] as Record<string, any>;
    expect(card.borderRadius).toBe(16);
    expect(card.tokenBindings).toEqual({ borderRadius: "tok_space" });
  });

  it("clears the row's token when a literal border colour is patched", () => {
    // A stroke row's colour has three sources — `color`, `paint`, and the token
    // `tokenId` names — and `applyToPaint` re-materialises the last one after the
    // merge. A patch that dropped only the first two painted the old colour.
    const stroked = normalizeDesignDocument(doc([frame({ borderColor: "$color/ink" })])).document;
    const result = applyOps(stroked, [{ op: "patch", targetId: "card", props: { "border-color": "#ff0000" } }]);
    expect(result.outcomes[0]).toMatchObject({ ok: true });
    const card = getActivePage(result.doc).children[0] as Record<string, any>;
    expect(card.strokes[0].color.toLowerCase()).toBe("#ff0000");
    expect(card.strokes[0].tokenId).toBeUndefined();
  });
});

describe("the failures are loud", () => {
  it("reports a name no token carries, and drops the declaration", () => {
    const { element, tokenRepairs } = only([{ id: "e", type: "rect", background: "$color/surfce" }]);
    expect(element.fills?.[0]?.tokenId).toBeUndefined();
    expect(element.background).toBeUndefined();
    expect(tokenRepairs.length).toBe(1);
    expect(tokenRepairs[0].path).toBe("/pages/0/children/0/background");
    // Absent severity is what makes `fish check` fail on it.
    expect(tokenRepairs[0].severity).toBeUndefined();
  });

  it("reports a colour token in a number slot", () => {
    const { tokenRepairs } = only([frame({ gap: "$color/ink" })]);
    expect(tokenRepairs.length).toBe(1);
    expect(tokenRepairs[0].message).toContain("not a number token");
  });

  it("reports a number token in a colour slot", () => {
    const { tokenRepairs } = only([{ id: "e", type: "rect", background: "$space/md" }]);
    expect(tokenRepairs.length).toBe(1);
    expect(tokenRepairs[0].message).toContain("not a colour token");
  });

  it("reports a name that two tokens share instead of picking one", () => {
    const dup = [
      { id: "tok_a", name: "primary", type: "color", value: "#FFFFFF" },
      { id: "tok_b", name: "primary", type: "color", value: "#000000" }
    ];
    const { element, tokenRepairs } = only([{ id: "e", type: "rect", background: "$primary" }], { tokens: dup });
    expect(element.fills?.[0]?.tokenId).toBeUndefined();
    expect(tokenRepairs.length).toBe(1);
    expect(tokenRepairs[0].message).toContain("more than one token");
  });

  it("says the value was dropped when the token is not the problem", () => {
    const broken = [{ id: "tok_bad", name: "color/bad", type: "color", value: "not-a-colour" }];
    const { tokenRepairs } = only([{ id: "e", type: "rect", background: "$color/bad" }], { tokens: broken });
    expect(tokenRepairs.some((repair) => repair.message.includes("whose value was dropped"))).toBe(true);
  });

  it("refuses the slots that have no reader", () => {
    const { tokenRepairs } = only([frame({ "border-top-width": "$stroke/thin", "border-left-width": "$stroke/thin" })]);
    expect(tokenRepairs.length).toBe(2);
    expect(tokenRepairs.every((repair) => repair.message.includes("not supported"))).toBe(true);
  });

  it("refuses a type slot on a layer that cannot read it", () => {
    const { tokenRepairs } = only([frame({ "font-size": "$type/body" })]);
    expect(tokenRepairs.length).toBe(1);
    expect(tokenRepairs[0].message).toContain("text layer only");
  });

  it("fails `fish check` on a name that resolves to nothing", () => {
    // The verdict `fish check` reaches from the repairs, not the repairs alone:
    // a severity of "info" would leave the command green while the layer lost
    // its ink.
    const { repairs } = normalize([{ id: "e", type: "rect", background: "$color/surfce" }]);
    expect(checkVerdict(repairs, 0, 0, false)).toMatchObject({ ok: false, failReason: " (repairs)" });
  });
});

describe("unchanged documents stay unchanged", () => {
  it("does not touch a document that refers to no token", () => {
    const plain = doc([
      { id: "e", type: "rect", background: "#FF0000" },
      { id: "f", type: "frame", display: "flex", gap: 8, padding: 12 }
    ]);
    const { repairs } = normalizeDesignDocument(plain);
    expect(repairs.filter((repair) => repair.kind === "token")).toEqual([]);
  });

  it("is idempotent: normalizing the output again changes nothing", () => {
    const once = normalize([frame({ gap: "$space/md", background: "$color/surface" })]).document;
    const twice = normalizeDesignDocument(once).document;
    expect(twice.pages).toEqual(once.pages);
  });

  it("round-trips through documentToPlainObject without alias-conflict repairs", () => {
    const authored = [
      frame({
        id: "card_radius",
        borderRadius: "$radius/card",
        gap: "$space/md",
        padding: "$space/md",
        strokes: [{ color: "#000000", width: 1 }],
        strokeWidth: "$stroke/thin"
      }),
      frame({
        id: "card_corner",
        borderRadius: 4,
        "border-top-left-radius": "$radius/card"
      }),
      {
        id: "label",
        type: "text",
        x: 0,
        y: 0,
        width: 80,
        height: 20,
        content: "Hi",
        "font-size": "$type/body"
      }
    ];
    const once = normalize(authored);
    expect(once.repairs).toEqual([]);

    const serialized = JSON.parse(JSON.stringify(documentToPlainObject(once.document)));
    const roundTripped = normalizeDesignDocument(serialized);
    expect(roundTripped.repairs).toEqual([]);

    const children = getActivePage(roundTripped.document).children as Array<Record<string, any>>;
    expect(children.find((c) => c.id === "card_radius")?.borderRadius).toBe(12);
    expect(children.find((c) => c.id === "card_corner")?.borderRadius).toEqual([12, 4, 4, 4]);
    expect(children.find((c) => c.id === "label")?.style?.fontSize).toBe(14);
  });
});

describe("the op verbs lower the same way a file load does", () => {
  const base = () => normalizeDesignDocument(doc([frame({})])).document;

  it("patches an element with a token reference", () => {
    const result = applyOps(base(), [
      { op: "patch", targetId: "card", props: { gap: "$space/md", background: "$color/surface" } }
    ]);
    expect(result.outcomes[0]).toMatchObject({ ok: true });
    const card = getActivePage(result.doc).children[0] as Record<string, any>;
    expect(card.gap).toBe(16);
    expect(card.tokenBindings).toEqual({ gap: "tok_space" });
    expect(card.fills).toEqual([{ type: "solid", color: "#f7f7f7", tokenId: "tok_surface" }]);
  });

  it("fails a patch whose token does not exist, instead of reporting it applied", () => {
    const result = applyOps(base(), [
      { op: "patch", targetId: "card", props: { gap: "$space/huge" } }
    ]);
    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].detail).toContain("names no token");
    // Nothing half-applied: the document is the one it was given.
    expect(getActivePage(result.doc).children[0]).toEqual(getActivePage(base()).children[0]);
  });

  it("inserts an element authored with tokens", () => {
    const result = applyOps(base(), [
      { op: "insert", element: { id: "chip", type: "rect", width: 40, height: 20, background: "$color/ink" } }
    ]);
    expect(result.outcomes[0].ok).toBe(true);
    const chip = getActivePage(result.doc).children.find((el) => el.id === "chip") as Record<string, any>;
    expect(chip.fills).toEqual([{ type: "solid", color: "#111111", tokenId: "tok_ink" }]);
  });
});

describe("P1-7: var() token bridge, sizing, padding sides, and spans", () => {
  const modeTokens = [
    { id: "tok_bg", name: "color/bg", type: "color", value: "#FFFFFF", modes: { dark: "#121212" } },
    { id: "tok_border", name: "color/border", type: "color", value: "#E2E8F0", modes: { dark: "#334155" } },
    { id: "tok_pad", name: "space/md", type: "number", value: 16, category: "spacing", modes: { compact: 8 } },
    { id: "tok_gap", name: "space/sm", type: "number", value: 8, category: "spacing", modes: { compact: 4 } },
    { id: "tok_w", name: "size/card", type: "number", value: 320, category: "sizing", modes: { compact: 260 } },
    { id: "tok_r", name: "radius/card", type: "number", value: 12, category: "radius", modes: { compact: 6 } },
    { id: "tok_type", name: "type/body", type: "number", value: 14, category: "typography", modes: { compact: 12 } }
  ];
  const themeModes = [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" }
  ];
  const densityModes = [
    { id: "default", name: "Default" },
    { id: "compact", name: "Compact" }
  ];

  it("bridges var(--name) to live color and number token bindings across slots", () => {
    const { document, repairs } = normalizeDesignDocument(
      doc(
        [
          frame({
            id: "card",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            gap: "var(--space-sm)",
            width: "var(--size-card)",
            height: "$space/md",
            borderRadius: "var(--radius-card)",
            effects: [{ type: "drop-shadow", offsetX: 0, offsetY: 2, blur: 8, color: "var(--color-border)" }],
            children: [
              { id: "txt", type: "text", content: "Hello", fontSize: "var(--type-body)", color: "var(--color-border)" }
            ]
          })
        ],
        { tokens: modeTokens, modes: themeModes, numberModes: densityModes, activeTheme: "dark", activeNumberMode: "compact" }
      ) as any
    );

    expect(repairs.filter((r) => r.kind === "token")).toEqual([]);
    const card = document.pages![0].children![0] as Record<string, any>;
    expect(card.fills).toEqual([{ type: "solid", color: "#121212", tokenId: "tok_bg" }]);
    expect(card.strokes).toEqual([{ color: "#334155", width: 1, style: "solid", align: "inside", tokenId: "tok_border" }]);
    expect(card.effects[0]).toMatchObject({ color: "#334155", tokenId: "tok_border" });
    expect(card.width).toBe(260);
    expect(card.height).toBe(8);
    expect(card.tokenBindings).toEqual({
      gap: "tok_gap",
      width: "tok_w",
      height: "tok_pad",
      borderRadius: "tok_r"
    });
    expect(layoutOf(card as any)).toMatchObject({ gap: 4 });
    expect(card.borderRadius).toBe(6);

    const txt = card.children[0] as Record<string, any>;
    expect(txt.fills).toEqual([{ type: "solid", color: "#334155", tokenId: "tok_border" }]);
    expect(txt.style.fontSize).toBe(12);
    expect(txt.tokenBindings).toEqual({ fontSize: "tok_type" });

    // Switching back to light/default modes via dual storage updates all bound values.
    const switched = syncDualStorage(
      card as DesignElement,
      { tokens: document.tokens ?? [], styles: document.styles ?? [] },
      "light",
      "default"
    ) as Record<string, any>;
    expect(switched.fills).toEqual([{ type: "solid", color: "#ffffff", tokenId: "tok_bg" }]);
    expect(switched.strokes[0].color).toBe("#e2e8f0");
    expect(switched.width).toBe(320);
    expect(switched.height).toBe(16);
    expect(switched.borderRadius).toBe(12);
    expect(layoutOf(switched as any)?.gap).toBe(8);
  });

  it("lets doc.variables take precedence over tokens[] and unwraps var() fallbacks", () => {
    const { document, repairs } = normalizeDesignDocument(
      doc(
        [
          frame({
            id: "a",
            background: "var(--color-bg)",
            borderColor: "var(--missing-var, var(--color-border))",
            gap: "var(--unknown-gap, $space/sm)"
          })
        ],
        { tokens: modeTokens, variables: { "--color-bg": "#ABCDEF" } }
      ) as any
    );
    expect(repairs.filter((r) => r.kind === "token")).toEqual([]);
    const a = document.pages![0].children![0] as Record<string, any>;
    // Explicit variable wins over token binding and folds directly into the fill literal.
    expect(a.fills).toEqual([{ type: "solid", color: "#ABCDEF" }]);
    // Missing var() with token fallback unwraps recursively to bind the fallback token.
    expect(a.strokes).toEqual([{ color: "#e2e8f0", width: 1, style: "solid", align: "inside", tokenId: "tok_border" }]);
    expect(a.tokenBindings).toEqual({ gap: "tok_gap" });
    expect(layoutOf(a as any)?.gap).toBe(8);
  });

  it("reports an unresolved var() when neither variables nor tokens define it", () => {
    const out = normalizeDesignDocument(doc([frame({ background: "var(--does-not-exist)" })], { tokens: modeTokens }) as any);
    expect(checkVerdict(out.repairs, 0, 0, false)).toMatchObject({ ok: false, failReason: " (repairs)" });
  });

  it("resolves var(--name) tokens inside doc.styles[]", () => {
    const out = normalizeDesignDocument({
      version: "0.1",
      name: "StylesVar",
      canvas: { width: 200, height: 200, background: { type: "solid", color: "#FFFFFF" } },
      pages: [{ id: "p1", name: "P1", children: [{ id: "r", type: "rect", fillStyleId: "st_bg" }] }],
      tokens: modeTokens,
      styles: [
        { id: "st_bg", name: "surface/bg", styleType: "paint", paints: [{ type: "solid", color: "var(--color-bg)" }] },
        { id: "st_txt", name: "body/type", styleType: "text", style: { fontSize: "var(--type-body)" } }
      ],
      modes: themeModes,
      numberModes: densityModes,
      activeTheme: "dark",
      activeNumberMode: "compact"
    } as any);
    expect(out.repairs.filter((r) => r.kind === "token")).toEqual([]);
    expect(out.document.styles![0]).toMatchObject({
      paints: [{ type: "solid", color: "#121212", tokenId: "tok_bg" }]
    });
    expect(out.document.styles![1]).toMatchObject({
      style: { fontSize: 12, tokenBindings: { fontSize: "tok_type" } }
    });
  });

  it("pins width/height sizing to fixed when bound via token and clears on literal patch", () => {
    const { document } = normalizeDesignDocument(
      doc([
        {
          id: "colParent",
          type: "frame",
          display: "flex",
          flexDirection: "column",
          width: 400,
          height: 300,
          children: [frame({ id: "child", width: "var(--size-card)", height: "$space/md" })]
        },
        {
          id: "rowParent",
          type: "frame",
          display: "flex",
          flexDirection: "row",
          width: 400,
          height: 300,
          children: [{ id: "label", type: "text", content: "Hi", width: "var(--size-card)", height: "$space/md" }]
        }
      ], { tokens: modeTokens }) as any
    );
    const colParent = document.pages![0].children![0] as Record<string, any>;
    const child = colParent.children[0] as Record<string, any>;
    expect(child.width).toBe(320);
    expect(child.height).toBe(16);
    expect(child.sizing).toMatchObject({ width: "fixed" });
    expect(child.tokenBindings).toEqual({ width: "tok_w", height: "tok_pad" });

    const rowParent = document.pages![0].children![1] as Record<string, any>;
    const label = rowParent.children[0] as Record<string, any>;
    expect(label.width).toBe(320);
    expect(label.height).toBe(16);
    expect(label.sizing).toMatchObject({ width: "fixed", height: "fixed" });
    expect(label.tokenBindings).toEqual({ width: "tok_w", height: "tok_pad" });

    const patched = applyOps(document, [{ op: "patch", targetId: "child", props: { width: 240 } }]);
    expect(patched.outcomes[0].ok).toBe(true);
    const updatedParent = getActivePage(patched.doc).children[0] as Record<string, any>;
    const updatedChild = updatedParent.children[0] as Record<string, any>;
    expect(updatedChild.width).toBe(240);
    expect(updatedChild.tokenBindings).toEqual({ height: "tok_pad" });
  });

  it("supports per-side object, array, and string padding shorthands with live bindings", () => {
    const { document, repairs } = normalizeDesignDocument(
      doc(
        [
          frame({
            id: "obj",
            padding: { top: "$space/md", right: 12, bottom: "var(--space-sm)", left: 4 }
          }),
          frame({
            id: "short",
            padding: { t: "$space/sm", b: "$space/md" }
          }),
          frame({
            id: "arr",
            padding: ["$space/md", "$space/sm"]
          }),
          frame({
            id: "str",
            padding: "var(--space-md) 1rem var(--space-sm)"
          }),
          frame({
            id: "objMixed",
            padding: { top: "$space/md", right: "1rem" }
          })
        ],
        { tokens: modeTokens }
      ) as any
    );
    expect(repairs.filter((r) => r.kind === "token")).toEqual([]);
    const [obj, shortEl, arr, strEl, objMixed] = document.pages![0].children! as Array<Record<string, any>>;

    expect(layoutOf(obj as any)?.padding).toEqual([16, 12, 8, 4]);
    expect(obj.tokenBindings).toEqual({ paddingTop: "tok_pad", paddingBottom: "tok_gap" });

    expect(layoutOf(shortEl as any)?.padding).toEqual([8, 0, 16, 0]);
    expect(shortEl.tokenBindings).toEqual({ paddingTop: "tok_gap", paddingBottom: "tok_pad" });

    expect(layoutOf(arr as any)?.padding).toEqual([16, 8, 16, 8]);
    expect(arr.tokenBindings).toEqual({
      paddingTop: "tok_pad",
      paddingRight: "tok_gap",
      paddingBottom: "tok_pad",
      paddingLeft: "tok_gap"
    });

    expect(layoutOf(strEl as any)?.padding).toEqual([16, 16, 8, 16]);
    expect(strEl.tokenBindings).toEqual({
      paddingTop: "tok_pad",
      paddingBottom: "tok_gap"
    });
    expect(layoutOf(objMixed as any)?.padding).toEqual([16, 16, 0, 0]);
    expect(objMixed.tokenBindings).toEqual({ paddingTop: "tok_pad" });

    // Mode switch via dual storage updates only bound padding sides cleanly.
    const compactObj = syncDualStorage(
      obj as DesignElement,
      { tokens: document.tokens ?? [], styles: [] },
      undefined,
      "compact"
    ) as Record<string, any>;
    expect(layoutOf(compactObj as any)?.padding).toEqual([8, 12, 4, 4]);

    // Round-trip plain JSON preserves side bindings, and unbinding "padding" clears them.
    const roundTripped = normalizeDesignDocument(documentToPlainObject(document) as any).document.pages![0].children![0];
    expect(roundTripped.tokenBindings).toEqual({ paddingTop: "tok_pad", paddingBottom: "tok_gap" });
    const unbound = unbindNumberTokenFromElement(obj as DesignElement, "padding");
    expect(unbound.tokenBindings).toBeUndefined();
  });

  it("materialises $token and var(--name) inside spans[].style in element modes without adding span tokenId", () => {
    const { document, repairs } = normalizeDesignDocument(
      doc(
        [
          {
            id: "card",
            type: "frame",
            themeMode: "dark",
            numberMode: "compact",
            children: [
              {
                id: "rich",
                type: "text",
                spans: [
                  { text: "A", style: { color: "var(--color-border)", fontSize: "$type/body", letterSpacing: "var(--space-sm)" } },
                  { text: "B", style: { color: "$color/bg" } }
                ]
              }
            ]
          }
        ],
        { tokens: modeTokens, modes: themeModes, numberModes: densityModes, activeTheme: "light", activeNumberMode: "default" }
      ) as any
    );
    expect(repairs.filter((r) => r.kind === "token")).toEqual([]);
    const rich = (document.pages![0].children![0] as any).children[0];
    expect(rich.spans[0].style).toEqual({ color: "#334155", fontSize: 12, letterSpacing: 4 });
    expect(rich.spans[1].style).toEqual({ color: "#121212" });
    expect(rich.spans[0].style.tokenId).toBeUndefined();
  });

  it("applies var() tokens, width/height, and padding sides in patch, insert, and replace ops", () => {
    const base = normalizeDesignDocument(
      doc([frame({ id: "root", width: 500, height: 400 })], {
        tokens: modeTokens,
        modes: themeModes,
        numberModes: densityModes,
        activeTheme: "dark",
        activeNumberMode: "compact"
      }) as any
    ).document;

    const inserted = applyOps(base, [
      {
        op: "insert",
        parentId: "root",
        element: {
          id: "kid",
          type: "frame",
          display: "flex",
          width: "var(--size-card)",
          padding: { top: "$space/md", left: "var(--space-sm)" },
          background: "var(--color-bg)"
        }
      }
    ]);
    expect(inserted.outcomes[0].ok).toBe(true);
    const rootAfterInsert = getActivePage(inserted.doc).children[0] as any;
    const insertedKid = rootAfterInsert.children[0];
    expect(layoutOf(insertedKid)?.padding).toEqual([8, 0, 0, 4]);
    expect(insertedKid.tokenBindings).toEqual({ width: "tok_w", paddingTop: "tok_pad", paddingLeft: "tok_gap" });

    const patched = applyOps(inserted.doc, [
      {
        op: "patch",
        targetId: "kid",
        props: { padding: { bottom: "$space/md" } }
      }
    ]);
    expect(patched.outcomes[0].ok).toBe(true);
    const rootEl = getActivePage(patched.doc).children[0] as any;
    const kid = rootEl.children[0];
    expect(kid.width).toBe(260);
    expect(kid.fills).toEqual([{ type: "solid", color: "#121212", tokenId: "tok_bg" }]);
    expect(layoutOf(kid)?.padding).toEqual([0, 0, 8, 0]);
    expect(kid.tokenBindings).toEqual({ width: "tok_w", paddingBottom: "tok_pad" });

    const replaced = applyOps(patched.doc, [
      {
        op: "replace",
        targetId: "kid",
        element: {
          type: "rect",
          width: "var(--size-card)",
          height: "var(--space-md)",
          background: "$color/border"
        }
      }
    ]);
    expect(replaced.outcomes[0].ok).toBe(true);
    const kid2 = (getActivePage(replaced.doc).children[0] as any).children[0];
    expect(kid2.width).toBe(260);
    expect(kid2.height).toBe(8);
    expect(kid2.fills).toEqual([{ type: "solid", color: "#334155", tokenId: "tok_border" }]);

    // Unknown var() without fallback in insert must fail rather than shipping literal var().
    const badInsert = applyOps(base, [
      { op: "insert", parentId: "root", element: { id: "bad", type: "rect", margin: "var(--missing)" } }
    ]);
    expect(badInsert.outcomes[0].ok).toBe(false);
  });
});

describe("the published dialect keeps up", () => {
  const dsl = fs.readFileSync(path.join(root, "agent-kit/references/dsl.md"), "utf-8");

  it("documents every property the shorthand can bind", () => {
    // Every bindable slot in `TOKEN_SHORTHAND_BINDINGS` must be named in `dsl.md`
    // so an agent authoring by the specification can discover all supported targets.
    const row = dsl
      .split("\n")
      .find((line) => line.trimStart().startsWith("| `tokenBindings: { prop: tokenId }`"));
    expect(row, "dsl.md still documents tokenBindings").toBeTruthy();
    const cell = row!.split("|")[3];
    expect(cell, "the row still lists the properties").toBeTruthy();
    const documented = new Set([...cell!.matchAll(/`([A-Za-z-]+)`/g)].map((match) => match[1]));

    for (const key of TOKEN_SHORTHAND_KEYS.number) {
      const prop = TOKEN_SHORTHAND_BINDINGS[key];
      expect(documented.has(prop), `${prop} is bindable but not documented`).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { getActivePage } from "../src/core/dsl/document-ops";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import {
  collectDependentTokenIds,
  colorTokenValue,
  isTokenAliasRef,
  lookupToken,
  numberTokenValue,
  rawTokenSlot,
  toTokenMap,
  tryColorTokenValue,
  tryNumberTokenValue,
  wouldTokenAliasCycle
} from "../src/core/dsl/token-value";
import type {
  ColorToken,
  DesignDocument,
  DesignElement,
  DocumentMode,
  NumberToken,
  PaintStyle
} from "../src/core/dsl/types";
import { collectReferencedTokens } from "../src/core/interactions/clipboard-payload";
import { switchDocumentNumberMode, switchDocumentTheme } from "../src/core/interactions/mode-ops";
import { countNumberTokenUses } from "../src/core/interactions/number-token-ops";
import { removeTokenFromDoc, updateTokenInDoc } from "../src/core/interactions/style-ops";
import { countTokenUses } from "../src/core/interactions/token-ops";
import { validateTokenRefs } from "../src/core/validate-tokens";
import { writeColorToken, writeNumberToken } from "../src/ui/tokens/token-mode-patch";

function makeDoc(
  elements: DesignElement[] = [],
  extra: Partial<DesignDocument> = {}
): DesignDocument {
  return {
    version: "0.1",
    name: "Alias Test",
    canvas: { width: 400, height: 300 },
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas: { width: 400, height: 300 },
        children: elements
      }
    ],
    activePageId: "page_1",
    ...extra
  } as DesignDocument;
}

describe("token-value alias resolution & DAG helpers", () => {
  const primLightBlue: ColorToken = {
    id: "tok_blue",
    name: "blue/500",
    type: "color",
    value: "#3B82F6",
    modes: { dark: "#60A5FA" }
  };
  const primSlate: ColorToken = {
    id: "tok_slate",
    name: "slate/900",
    type: "color",
    value: "#0F172A",
    modes: { dark: "#F8FAFC" }
  };
  const brandAccent: ColorToken = {
    id: "tok_brand",
    name: "brand/accent",
    type: "color",
    value: { ref: "tok_blue" }
  };
  const actionBg: ColorToken = {
    id: "tok_action",
    name: "action/bg",
    type: "color",
    value: { ref: "tok_brand" },
    modes: { dark: { ref: "tok_slate" } }
  };

  const spaceBase: NumberToken = {
    id: "tok_space_base",
    name: "space/base",
    type: "number",
    category: "spacing",
    value: 8,
    modes: { compact: 4 }
  };
  const spaceCard: NumberToken = {
    id: "tok_space_card",
    name: "space/card",
    type: "number",
    category: "spacing",
    value: { ref: "tok_space_base" }
  };

  const allTokens = [primLightBlue, primSlate, brandAccent, actionBg, spaceBase, spaceCard];

  it("resolves chained aliases in the requested mode scope", () => {
    expect(colorTokenValue(actionBg, "default", allTokens)).toBe("#3B82F6");
    // In dark mode, actionBg overrides directly to tok_slate
    expect(colorTokenValue(actionBg, "dark", allTokens)).toBe("#F8FAFC");
    // brandAccent has no dark override so it inherits base ref tok_blue, resolved in dark mode
    expect(colorTokenValue(brandAccent, "dark", allTokens)).toBe("#60A5FA");

    expect(numberTokenValue(spaceCard, "default", allTokens)).toBe(8);
    expect(numberTokenValue(spaceCard, "compact", allTokens)).toBe(4);
  });

  it("detects cycles cleanly without looping and returns undefined from try* readers", () => {
    const a: ColorToken = { id: "tok_a", name: "a", type: "color", value: { ref: "tok_b" } };
    const b: ColorToken = { id: "tok_b", name: "b", type: "color", value: { ref: "tok_c" } };
    const c: ColorToken = { id: "tok_c", name: "c", type: "color", value: { ref: "tok_a" } };
    const cyclic = [a, b, c];

    expect(tryColorTokenValue(a, "default", cyclic)).toBeUndefined();
    expect(tryNumberTokenValue({ id: "tok_n", name: "n", type: "number", value: { ref: "tok_missing" } }, "default", [])).toBeUndefined();
    expect(wouldTokenAliasCycle(allTokens, "tok_blue", "tok_blue")).toBe(true);
    expect(wouldTokenAliasCycle(allTokens, "tok_blue", "tok_action")).toBe(true);
    expect(wouldTokenAliasCycle(allTokens, "tok_blue", "tok_brand")).toBe(true);
    expect(wouldTokenAliasCycle(allTokens, "tok_brand", "tok_slate")).toBe(false);
  });

  it("collects all transitive dependents via collectDependentTokenIds", () => {
    const deps = collectDependentTokenIds(allTokens, "tok_blue");
    expect(deps).toEqual(new Set(["tok_blue", "tok_brand", "tok_action"]));
  });

  it("reads raw slots via rawTokenSlot preserving alias refs", () => {
    expect(rawTokenSlot(actionBg, "default", "default")).toEqual({ ref: "tok_brand" });
    expect(rawTokenSlot(actionBg, "dark", "default")).toEqual({ ref: "tok_slate" });
    expect(rawTokenSlot(brandAccent, "dark", "default")).toEqual({ ref: "tok_blue" });
  });
});

describe("normalize alias tokens and $name shorthand", () => {
  it("resolves forward/out-of-order $name alias shorthands in value and modes, and resolves layers", () => {
    const raw = {
      version: "0.1",
      name: "Alias Shorthand",
      canvas: { width: 400, height: 300 },
      modes: [
        { id: "default", name: "Default" },
        { id: "dark", name: "Dark" }
      ],
      numberModes: [
        { id: "default", name: "Default" },
        { id: "compact", name: "Compact" }
      ],
      tokens: [
        // Declared BEFORE its target primitive
        {
          id: "tok_sem_bg",
          name: "surface/primary",
          type: "color",
          value: "$brand-primary",
          modes: { dark: "$slate/900" }
        },
        {
          id: "tok_brand",
          name: "brand/primary",
          type: "color",
          value: "#2563EB"
        },
        {
          id: "tok_slate",
          name: "slate/900",
          type: "color",
          value: "#0F172A",
          modes: { dark: "#111827" }
        },
        {
          id: "tok_gap_sem",
          name: "gap/card",
          type: "number",
          category: "spacing",
          value: "$gap-base"
        },
        {
          id: "tok_gap_base",
          name: "gap/base",
          type: "number",
          category: "spacing",
          value: 16,
          modes: { compact: 8 }
        }
      ],
      pages: [
        {
          id: "page_1",
          name: "Page 1",
          canvas: { width: 400, height: 300 },
          children: [
            {
              id: "card",
              name: "Card",
              type: "frame",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              display: "flex",
              gap: "$gap-card",
              background: "$surface-primary"
            }
          ]
        }
      ]
    };

    const { document: normalized, repairs } = normalizeDesignDocument(raw);
    expect(repairs.filter((r) => r.message.includes("alias"))).toEqual([]);
    const doc = normalized as DesignDocument;

    const semBg = doc.tokens?.find((t) => t.id === "tok_sem_bg") as ColorToken;
    expect(semBg.value).toEqual({ ref: "tok_brand" });
    expect(semBg.modes?.dark).toEqual({ ref: "tok_slate" });

    const gapSem = doc.tokens?.find((t) => t.id === "tok_gap_sem") as NumberToken;
    expect(gapSem.value).toEqual({ ref: "tok_gap_base" });

    const card = getActivePage(doc).children[0] as any;
    expect(card.fills[0]).toMatchObject({ tokenId: "tok_sem_bg", color: "#2563eb" });
    expect(card.tokenBindings.gap).toBe("tok_gap_sem");
    expect(card.gap).toBe(16);
  });

  it("drops invalid cross-type base entries or dangling $name mode overrides cleanly", () => {
    const raw = {
      version: "0.1",
      name: "Bad Alias Shorthand",
      canvas: { width: 400, height: 300 },
      tokens: [
        { id: "tok_num", name: "space/md", type: "number", category: "spacing", value: 12 },
        {
          id: "tok_bad_color",
          name: "bad/color",
          type: "color",
          value: "$space-md"
        },
        {
          id: "tok_partial_color",
          name: "partial/color",
          type: "color",
          value: "#112233",
          modes: { dark: "$missing-tok" }
        }
      ],
      pages: [{ id: "page_1", name: "Page 1", canvas: { width: 400, height: 300 }, children: [] }]
    };

    const { document: normalized, repairs } = normalizeDesignDocument(raw);
    expect(repairs.some((r) => r.message.includes("bad/color"))).toBe(true);
    expect(repairs.some((r) => r.message.includes("partial/color"))).toBe(true);
    const tokens = (normalized as DesignDocument).tokens ?? [];
    expect(tokens.find((t) => t.id === "tok_bad_color")).toBeUndefined();
    const partial = tokens.find((t) => t.id === "tok_partial_color") as ColorToken;
    expect(partial.value).toBe("#112233");
    expect(partial.modes).toBeUndefined();
  });
});

describe("transitive cascade, mode switching, delete materialization & clipboard", () => {
  const prim: ColorToken = {
    id: "tok_prim",
    name: "blue/500",
    type: "color",
    value: "#3B82F6",
    modes: { dark: "#60A5FA" }
  };
  const mid: ColorToken = {
    id: "tok_mid",
    name: "brand/accent",
    type: "color",
    value: { ref: "tok_prim" }
  };
  const leaf: ColorToken = {
    id: "tok_leaf",
    name: "action/fill",
    type: "color",
    value: { ref: "tok_mid" }
  };
  const numPrim: NumberToken = {
    id: "tok_np",
    name: "space/prim",
    type: "number",
    category: "spacing",
    value: 12,
    modes: { compact: 6 }
  };
  const numSem: NumberToken = {
    id: "tok_ns",
    name: "space/sem",
    type: "number",
    category: "spacing",
    value: { ref: "tok_np" }
  };
  const paintStyle: PaintStyle = {
    id: "style_action",
    name: "Action Fill",
    styleType: "paint",
    paints: [{ type: "solid", color: "#3B82F6", tokenId: "tok_leaf" }]
  };
  const rect: DesignElement = {
    id: "el_rect",
    name: "Box",
    type: "rect",
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    borderRadius: 12,
    fills: [{ type: "solid", color: "#3B82F6", tokenId: "tok_leaf" }],
    tokenBindings: { borderRadius: "tok_ns" }
  } as unknown as DesignElement;

  const baseDoc = makeDoc([rect], {
    modes: [
      { id: "default", name: "Default" },
      { id: "dark", name: "Dark" }
    ],
    numberModes: [
      { id: "default", name: "Default" },
      { id: "compact", name: "Compact" }
    ],
    tokens: [prim, mid, leaf, numPrim, numSem],
    styles: [paintStyle]
  });

  it("cascades primitive edits transitively through alias chains into styles and layers", () => {
    const edited = updateTokenInDoc(baseDoc, { ...prim, value: "#EF4444" });
    const styled = edited.styles?.[0] as PaintStyle;
    expect(styled.paints[0]).toMatchObject({ type: "solid", color: "#EF4444" });
    const box = getActivePage(edited).children[0] as any;
    expect(box.fills[0].color).toBe("#EF4444");
    expect(box.fills[0].tokenId).toBe("tok_leaf");

    const editedNum = updateTokenInDoc(edited, { ...numPrim, value: 20 });
    const box2 = getActivePage(editedNum).children[0] as any;
    expect(box2.borderRadius).toBe(20);
  });

  it("re-evaluates alias chains when switching theme or number modes", () => {
    const darkDoc = switchDocumentTheme(baseDoc, "dark");
    expect((darkDoc.styles?.[0] as PaintStyle).paints[0]).toMatchObject({ type: "solid", color: "#60A5FA" });
    expect((getActivePage(darkDoc).children[0] as any).fills[0].color).toBe("#60A5FA");

    const compactDoc = switchDocumentNumberMode(darkDoc, "compact");
    expect((getActivePage(compactDoc).children[0] as any).borderRadius).toBe(6);
  });

  it("counts upstream token aliases in countTokenUses & countNumberTokenUses", () => {
    expect(countTokenUses(baseDoc, "tok_prim")).toBe(1);
    expect(countTokenUses(baseDoc, "tok_mid")).toBe(1);
    expect(countTokenUses(baseDoc, "tok_leaf")).toBe(2); // 1 layer fill + 1 paint style
    expect(countNumberTokenUses(baseDoc, "tok_np")).toBe(1);
  });

  it("materializes upstream alias slots when deleting their referenced token", () => {
    const afterDelete = removeTokenFromDoc(baseDoc, "tok_prim");
    expect(afterDelete.tokens?.find((t) => t.id === "tok_prim")).toBeUndefined();
    const updatedMid = afterDelete.tokens?.find((t) => t.id === "tok_mid") as ColorToken;
    expect(updatedMid.value).toBe("#3B82F6");
    expect(updatedMid.modes?.dark).toBe("#60A5FA");

    const afterNumDelete = removeTokenFromDoc(afterDelete, "tok_np");
    const updatedNumSem = afterNumDelete.tokens?.find((t) => t.id === "tok_ns") as NumberToken;
    expect(updatedNumSem.value).toBe(12);
    expect(updatedNumSem.modes?.compact).toBe(6);
  });

  it("transitively collects aliased dependencies in collectReferencedTokens", () => {
    const copied = collectReferencedTokens(baseDoc.tokens, [rect]);
    expect(copied.map((t) => t.id)).toEqual(["tok_prim", "tok_mid", "tok_leaf", "tok_np", "tok_ns"]);
  });
});

describe("validateTokenRefs alias checks", () => {
  it("reports errors on cycles and cross-type refs, warnings on dangling refs, and nothing on valid DAGs", () => {
    const prim: ColorToken = { id: "tok_p", name: "p", type: "color", value: "#112233" };
    const validAlias: ColorToken = { id: "tok_v", name: "v", type: "color", value: { ref: "tok_p" } };
    expect(validateTokenRefs(makeDoc([], { tokens: [prim, validAlias] }))).toEqual([]);

    const a: ColorToken = { id: "tok_a", name: "a", type: "color", value: { ref: "tok_b" } };
    const b: ColorToken = { id: "tok_b", name: "b", type: "color", value: { ref: "tok_a" } };
    const cycIssues = validateTokenRefs(makeDoc([], { tokens: [a, b] }));
    expect(cycIssues.some((d) => d.level === "error" && d.message.toLowerCase().includes("circular"))).toBe(true);

    const num: NumberToken = { id: "tok_n", name: "n", type: "number", value: 4 };
    const cross: ColorToken = { id: "tok_x", name: "x", type: "color", value: { ref: "tok_n" } };
    const crossIssues = validateTokenRefs(makeDoc([], { tokens: [num, cross] }));
    expect(crossIssues.some((d) => d.level === "error")).toBe(true);

    const dangling: ColorToken = { id: "tok_d", name: "d", type: "color", value: { ref: "tok_missing" } };
    const warnIssues = validateTokenRefs(makeDoc([], { tokens: [dangling] }));
    expect(warnIssues.some((d) => d.level === "warning")).toBe(true);
  });
});

describe("table writeColorToken & writeNumberToken preserve and update alias slots", () => {
  const modes: DocumentMode[] = [
    { id: "default", name: "Default" },
    { id: "dark", name: "Dark" }
  ];

  it("preserves base and mode alias refs across renames and unrelated mode edits", () => {
    const prim: ColorToken = { id: "tok_p", name: "p", type: "color", value: "#111111" };
    const tok: ColorToken = {
      id: "tok_c",
      name: "c",
      type: "color",
      value: { ref: "tok_p" },
      modes: { dark: "#222222" }
    };
    const renamed = writeColorToken(tok, modes, "default", { name: "c/renamed" }, [prim, tok]);
    expect(renamed.name).toBe("c/renamed");
    expect(isTokenAliasRef(renamed.value)).toBe(true);
    expect(renamed.value).toEqual({ ref: "tok_p" });
    expect(renamed.modes?.dark).toBe("#222222");

    const modeAliased = writeColorToken(
      renamed,
      modes,
      "default",
      { mode: { id: "dark", patch: { ref: "tok_p" } } },
      [prim, renamed]
    );
    expect(modeAliased.modes?.dark).toEqual({ ref: "tok_p" });
    expect(modeAliased.value).toEqual({ ref: "tok_p" });
  });

  it("preserves number token alias refs across category changes and mode edits", () => {
    const prim: NumberToken = { id: "tok_np", name: "np", type: "number", value: 12 };
    const tok: NumberToken = {
      id: "tok_n",
      name: "n",
      type: "number",
      category: "spacing",
      value: { ref: "tok_np" },
      modes: { dark: 8 }
    };
    const recategorized = writeNumberToken(tok, modes, "default", { category: "radius" }, [prim, tok]);
    expect(recategorized.category).toBe("radius");
    expect(recategorized.value).toEqual({ ref: "tok_np" });
    expect(recategorized.modes?.dark).toBe(8);

    const detached = writeNumberToken(recategorized, modes, "default", { value: 12 }, [prim, recategorized]);
    expect(detached.value).toBe(12);
  });
});

describe("toTokenMap caching & duplicate-id semantics", () => {
  it("caches by array identity even with duplicate ids and preserves first-wins lookup", () => {
    const first: ColorToken = { id: "tok_dup", name: "first", type: "color", value: "#111111" };
    const second: ColorToken = { id: "tok_dup", name: "second", type: "color", value: "#222222" };
    const list = [first, second];
    const map1 = toTokenMap(list);
    const map2 = toTokenMap(list);
    expect(map2).toBe(map1);
    expect(map1.size).toBe(1);
    expect(lookupToken(list, "tok_dup")).toBe(first);
  });
});

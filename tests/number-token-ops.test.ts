import { describe, expect, it } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { DesignDocument, DesignElement } from "../src/core/dsl/types";
import {
  bindNumberTokenToElement,
  countNumberTokenUses,
  createNumberToken,
  findNumberToken,
  isNumberToken,
  mergeNumberTokenOrder,
  reorderNumberTokens,
  unbindNumberTokenFromElement,
  updateNumberToken
} from "../src/core/interactions/number-token-ops";
import {
  addTokenToDoc,
  removeTokenFromDoc,
  syncDualStorage,
  updateTokenInDoc
} from "../src/core/interactions/style-ops";
import { layoutOf, withLayout } from "../src/core/dsl/layout-flat";

function makeDoc(elements: DesignElement[] = [], tokens: any[] = []): DesignDocument {
  return {
    version: "0.1",
    id: "doc_test",
    name: "Test Doc",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: { unit: "px", background: { type: "solid", color: "#FFFFFF" } },
    activePageId: "page_1",
    pages: [{ id: "page_1", name: "Page 1", canvas: { unit: "px", background: { type: "solid", color: "#FFFFFF" } }, children: elements }],
    elements,
    tokens
  };
}

describe("number-token-ops", () => {
  it("is the table a number lives in, not a style that happens to hold one", () => {
    const numTok = createNumberToken("space/md", 16, "spacing");
    const colorTok = { id: "c1", name: "Brand", type: "color" as const, value: "#2563EB" };
    expect(isNumberToken(numTok)).toBe(true);
    expect(isNumberToken(colorTok)).toBe(false);
  });

  it("creates and updates number tokens", () => {
    const tok = createNumberToken("radius/base", 8, "radius", "Base radius");
    expect(tok.name).toBe("radius/base");
    expect(tok.value).toBe(8);
    expect(tok.category).toBe("radius");
    expect(tok.description).toBe("Base radius");

    const updated = updateNumberToken(tok, "radius/lg", 16, "radius", "Large radius");
    expect(updated.id).toBe(tok.id);
    expect(updated.name).toBe("radius/lg");
    expect(updated.value).toBe(16);
    expect(updated.description).toBe("Large radius");
  });

  it("finds number token in document", () => {
    const tok = createNumberToken("space/sm", 8, "spacing");
    const doc = makeDoc([], [tok]);
    expect(findNumberToken(doc.tokens ?? [], tok.id)).toEqual(tok);
    expect(findNumberToken(doc.tokens ?? [], "non_existent")).toBeUndefined();
    expect(findNumberToken(doc.tokens ?? [], undefined)).toBeUndefined();
  });

  it("binds and unbinds token to element", () => {
    const el: DesignElement = {
      id: "rect_1",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      borderRadius: 4
    };

    const bound = bindNumberTokenToElement(el, "borderRadius", "tok_radius_1", 12);
    expect(bound.tokenBindings?.borderRadius).toBe("tok_radius_1");
    expect((bound as any).borderRadius).toBe(12);

    const unbound = unbindNumberTokenFromElement(bound, "borderRadius");
    expect(unbound.tokenBindings).toBeUndefined();
    expect((unbound as any).borderRadius).toBe(12);
  });

  it("binds radius array on element", () => {
    const el: DesignElement = {
      id: "rect_1",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      borderRadius: [4, 4, 4, 4]
    };

    const bound = bindNumberTokenToElement(el, "borderRadius", "tok_radius_1", 16);
    expect(bound.tokenBindings?.borderRadius).toBe("tok_radius_1");
    expect((bound as any).borderRadius).toEqual([16, 16, 16, 16]);
  });

  it("counts number token uses accurately across pages and nested children", () => {
    const el1: DesignElement = {
      id: "frame_1",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      tokenBindings: { gap: "tok_space_1", borderRadius: "tok_radius_1" },
      children: [
        {
          id: "rect_child",
          type: "rect",
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          tokenBindings: { borderRadius: "tok_radius_1" }
        }
      ]
    };

    const doc = makeDoc([el1]);
    expect(countNumberTokenUses(doc, "tok_space_1")).toBe(1);
    expect(countNumberTokenUses(doc, "tok_radius_1")).toBe(2);
    expect(countNumberTokenUses(doc, "tok_unused")).toBe(0);
  });

  it("reorders number tokens among tokens, and leaves the other token type at its indices", () => {
    const t1 = createNumberToken("T1", 1);
    const t2 = createNumberToken("T2", 2);
    const t3 = createNumberToken("T3", 3);
    const color = { id: "c1", name: "Brand", type: "color" as const, value: "#2563EB" };

    const tokens = [t1, color, t2, t3];
    const reordered = reorderNumberTokens(tokens.filter(isNumberToken), 0, 2);
    expect(reordered.map((t) => t.name)).toEqual(["T2", "T1", "T3"]);
    expect(mergeNumberTokenOrder(tokens, reordered).map((t) => t.id)).toEqual([
      t2.id,
      color.id,
      t1.id,
      t3.id
    ]);
  });

  it("propagates number token update through updateStyleInDoc", () => {
    const tok = createNumberToken("space/md", 16, "spacing");
    const el: DesignElement = {
      id: "frame_1",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [],
      gap: 16,
      tokenBindings: { gap: tok.id }
    };
    const doc = makeDoc([el], [tok]);

    const updatedTok = updateNumberToken(tok, "space/md", 24, "spacing");
    const nextDoc = updateTokenInDoc(doc, updatedTok);

    const activeEl = getActivePage(nextDoc).children[0] as any;
    expect(activeEl.gap).toBe(24);
    expect(activeEl.tokenBindings.gap).toBe(tok.id);

    const pageEl = nextDoc.pages[0].children[0] as any;
    expect(pageEl.gap).toBe(24);
  });

  it("strips token bindings on delete in removeStyleFromDoc while preserving values", () => {
    const tok = createNumberToken("radius/base", 8, "radius");
    const el: DesignElement = {
      id: "rect_1",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      borderRadius: 8,
      tokenBindings: { borderRadius: tok.id }
    };
    const doc = makeDoc([el], [tok]);

    const nextDoc = removeTokenFromDoc(doc, tok.id);
    expect(nextDoc.styles?.some((s) => s.id === tok.id)).toBe(false);

    const activeEl = getActivePage(nextDoc).children[0] as any;
    expect(activeEl.borderRadius).toBe(8);
    expect(activeEl.tokenBindings).toBeUndefined();
  });

  it("binds typography tokens and cascades updates to text styles", () => {
    const tok = createNumberToken("font/title", 32, "typography");
    const textEl: DesignElement = {
      id: "text_1",
      type: "text",
      content: "Hello",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      style: {
        fontFamily: "Inter",
        fontSize: 16,
        color: "#000000"
      }
    };

    const bound = bindNumberTokenToElement(textEl, "fontSize", tok.id, tok.value);
    expect(bound.tokenBindings?.fontSize).toBe(tok.id);
    expect((bound as any).style.fontSize).toBe(32);

    const doc = makeDoc([bound], [tok]);
    const updatedTok = updateNumberToken(tok, "font/title", 36, "typography");
    const nextDoc = updateTokenInDoc(doc, updatedTok);

    const activeEl = getActivePage(nextDoc).children[0] as any;
    expect(activeEl.style.fontSize).toBe(36);
    expect(activeEl.tokenBindings.fontSize).toBe(tok.id);
  });

  it("binds and counts effect tokens, cascading updates to effect parameters", () => {
    const blurTok = createNumberToken("blur/lg", 16, "effect");
    const el: DesignElement = {
      id: "rect_fx",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      effects: [
        {
          type: "drop-shadow",
          color: "#00000040",
          offset: { x: 0, y: 4 },
          blur: 16,
          tokenBindings: { blur: blurTok.id }
        }
      ]
    };

    const doc = makeDoc([el], [blurTok]);
    expect(countNumberTokenUses(doc, blurTok.id)).toBe(1);

    const updatedTok = updateNumberToken(blurTok, "blur/lg", 24, "effect");
    const nextDoc = updateTokenInDoc(doc, updatedTok);

    const activeEl = getActivePage(nextDoc).children[0] as any;
    expect(activeEl.effects[0].blur).toBe(24);
    expect(activeEl.effects[0].tokenBindings.blur).toBe(blurTok.id);
  });

  it("triggers layout recalculation when gap or padding token is updated in updateStyleInDoc", () => {
    const gapTok = createNumberToken("gap/sm", 10, "spacing");
    const child1: DesignElement = { id: "c1", type: "rect", x: 0, y: 0, width: 50, height: 50 };
    const child2: DesignElement = { id: "c2", type: "rect", x: 60, y: 0, width: 50, height: 50 };
    const frame = withLayout(
      {
        id: "frame_1",
        type: "frame",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        tokenBindings: { gap: gapTok.id },
        children: [child1, child2]
      },
      { mode: "flex", direction: "row", gap: 10 }
    ) as DesignElement;

    const doc = makeDoc([frame], [gapTok]);
    const updatedTok = updateNumberToken(gapTok, "gap/sm", 30, "spacing");
    const nextDoc = updateTokenInDoc(doc, updatedTok);

    const activeFrame = getActivePage(nextDoc).children[0] as any;
    expect(layoutOf(activeFrame)?.gap).toBe(30);
    // In horizontal auto-layout with gap=30, child2 should be positioned at x = 0 + 50 + 30 = 80
    const nextChild2 = activeFrame.children[1];
    expect(nextChild2.x).toBe(80);
  });

  it("syncs number and effect token bindings in syncDualStorage", () => {
    const radTok = createNumberToken("rad/sm", 12, "radius");
    const blurTok = createNumberToken("blur/sm", 8, "effect");

    const el: DesignElement = {
      id: "rect_sync",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      borderRadius: 4,
      tokenBindings: { borderRadius: radTok.id },
      effects: [
        {
          type: "drop-shadow",
          color: "#000",
          offset: { x: 0, y: 2 },
          blur: 2,
          tokenBindings: { blur: blurTok.id }
        }
      ]
    };

    const tables = { tokens: [radTok, blurTok], styles: [] };

    const synced = syncDualStorage(el, tables) as any;
    expect(synced.borderRadius).toBe(12);
    expect(synced.effects[0].blur).toBe(8);
  });

  it("mints an id with the token prefix", () => {
    const tok = createNumberToken("test", 5);
    expect(tok.id.startsWith("tok_")).toBe(true);
  });

  it("binds individual corner tokens to an element", () => {
    const tlTok = createNumberToken("radius/tl", 10, "radius");
    const trTok = createNumberToken("radius/tr", 20, "radius");

    const el: DesignElement = {
      id: "rect_corners",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      borderRadius: [4, 4, 4, 4]
    };

    const withTl = bindNumberTokenToElement(el, "topLeftRadius", tlTok.id, tlTok.value);
    expect(withTl.tokenBindings?.topLeftRadius).toBe(tlTok.id);
    expect((withTl as any).borderRadius).toEqual([10, 4, 4, 4]);

    const withBoth = bindNumberTokenToElement(withTl, "topRightRadius", trTok.id, trTok.value);
    expect(withBoth.tokenBindings?.topLeftRadius).toBe(tlTok.id);
    expect(withBoth.tokenBindings?.topRightRadius).toBe(trTok.id);
    expect((withBoth as any).borderRadius).toEqual([10, 20, 4, 4]);

    // Unbinding one corner leaves the other intact
    const unbound = unbindNumberTokenFromElement(withBoth, "topLeftRadius");
    expect(unbound.tokenBindings?.topLeftRadius).toBeUndefined();
    expect(unbound.tokenBindings?.topRightRadius).toBe(trTok.id);

    // Binding uniform borderRadius clears corner tokens
    const uniform = bindNumberTokenToElement(withBoth, "borderRadius", "tok_uniform", 8);
    expect(uniform.tokenBindings).toEqual({ borderRadius: "tok_uniform" });
    expect((uniform as any).borderRadius).toEqual([8, 8, 8, 8]);
  });

  it("syncs corner token values across dual storage", () => {
    const tlTok = createNumberToken("radius/tl", 14, "radius");
    const brTok = createNumberToken("radius/br", 28, "radius");

    const el: DesignElement = {
      id: "rect_sync_corners",
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      borderRadius: [0, 5, 0, 5],
      tokenBindings: {
        topLeftRadius: tlTok.id,
        bottomRightRadius: brTok.id
      }
    };

    const tables = { tokens: [tlTok, brTok], styles: [] };
    const synced = syncDualStorage(el, tables) as any;
    expect(synced.borderRadius).toEqual([14, 5, 28, 5]);
  });
});


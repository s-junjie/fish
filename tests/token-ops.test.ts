import { describe, expect, it } from "vitest";
import { DesignElement } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/types";
import type { DesignDocument, DropShadowEffect, InstanceElement, RectElement, TextElement } from "../src/core/dsl/types";
import {
  colorTokensOf,
  colorTokenColor,
  countStyleUses,
  countTokenUses,
  createColorToken,
  mergeTokenOrder,
  reorderColorTokens,
  tokenAlphaPct,
  updateColorToken
} from "../src/core/interactions/token-ops";
import { createNumberToken } from "../src/core/interactions/number-token-ops";
import {
  addStyleToDoc,
  addTokenToDoc,
  createPaintStyle,
  removeStyleFromDoc,
  removeTokenFromDoc,
  updateStyleInDoc,
  updateTokenInDoc
} from "../src/core/interactions/style-ops";

function docWith(children: DesignElement[]): DesignDocument {
  const page = {
    id: "p1",
    name: "Page 1",
    canvas: { unit: "px" as const, background: { type: "solid" as const, color: "#FFFFFF" } },
    children
  };
  return {
    version: "0.1",
    id: "doc",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas: { unit: "px", background: { type: "solid", color: "#FFFFFF" } },
    pages: [page],
    activePageId: page.id
  };
}

describe("color tokens", () => {
  it("is the table an colour lives in, and a paint style is not one however few layers it has", () => {
    const token = createColorToken("action/primary", "#2563EB", "Primary action");
    expect(token.type).toBe("color");
    expect(colorTokenColor(token)).toBe("#2563EB");
    expect(token.description).toBe("Primary action");

    // The token list is the table filtered by type — a one-solid paint style is
    // a STYLE now, and shape no longer decides which list an entry appears in.
    let doc = docWith([]);
    doc = addTokenToDoc(doc, token);
    doc = addStyleToDoc(
      doc,
      createPaintStyle("surface/hero", [{ type: "solid", color: "#2563EB" }])
    );
    expect(colorTokensOf(doc.tokens).map((t) => t.id)).toEqual([token.id]);
    expect(doc.styles?.map((s) => s.name)).toEqual(["surface/hero"]);
  });

  it("keeps the id and carries alpha in the hex when a token changes colour", () => {
    const token = createColorToken("action/primary", "#2563EBcc");
    const updated = updateColorToken(token, "action/brand", "#E8A33D", "Amber action");
    expect(updated.id).toBe(token.id);
    expect(updated.name).toBe("action/brand");
    expect(colorTokenColor(updated)).toBe("#E8A33D");
    expect(updated.value).toBe("#E8A33D");
    expect(tokenAlphaPct(updated)).toBe(100);
    expect(tokenAlphaPct(token)).toBe(80);
    expect(updated.description).toBe("Amber action");
    expect("paints" in updated).toBe(false);
  });
});

describe("countTokenUses / countStyleUses", () => {
  it("counts a token's layer references once, not the active-page mirror twice", () => {
    const token = createColorToken("action/primary", "#2563EB");
    const rect = {
      id: "rect",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fills: [{ type: "solid", color: "#2563EB", tokenId: token.id }],
      strokes: [{ width: 1, color: "#2563EB", tokenId: token.id }],
      effects: [
        { type: "drop-shadow", color: "#2563EB", offset: { x: 0, y: 2 }, blur: 4, enabled: true, tokenId: token.id }
      ]
    } as RectElement;

    // Three references on one page; every one of them must be stripped.
    expect(countTokenUses(docWith([rect]), token.id)).toBe(3);
  });

  it("counts STYLE bindings and instance overrides once, not the active-page mirror twice", () => {
    const style = createPaintStyle("surface/card", [{ type: "solid", color: "#2563EB" }]);
    const rect = {
      id: "rect",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fillStyleId: style.id,
      strokeStyleId: style.id
    } as RectElement;
    const text = {
      id: "text",
      type: "text",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      content: "Hi",
      style: { fontFamily: "Inter", fontSize: 12, color: "#000000" },
      textStyleId: style.id
    } as TextElement;
    const instance = {
      id: "instance",
      type: "instance",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      componentId: "c1",
      overrides: [
        { targetId: "child", property: "fillStyleId", value: style.id },
        { targetId: "child", property: "content", value: "ignored" }
      ]
    } as unknown as InstanceElement;

    expect(countStyleUses(docWith([rect, text, instance]), style.id)).toBe(4);
  });
});

describe("effect token binding updates", () => {
  it("repaints bound effect colors when a color token is updated", () => {
    const token = createColorToken("shadow/brand", "#2563EB");
    const rect = {
      id: "rect",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      effects: [
        { type: "drop-shadow", color: "#2563EB", offset: { x: 0, y: 4 }, blur: 8, enabled: true, tokenId: token.id }
      ]
    } as RectElement;
    let doc = docWith([rect]);
    doc = addTokenToDoc(doc, token);

    const updatedToken = updateColorToken(token, "shadow/brand", "#DC2626");
    doc = updateTokenInDoc(doc, updatedToken);

    const updatedRect = getActivePage(doc).children[0] as RectElement;
    const effect = updatedRect.effects?.[0] as DropShadowEffect;
    expect(effect.color).toBe("#DC2626");
    expect(effect.tokenId).toBe(token.id);
  });

  it("detaches tokenId from effects when the token is removed from doc", () => {
    const token = createColorToken("shadow/brand", "#2563EB");
    const rect = {
      id: "rect",
      type: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      effects: [
        { type: "drop-shadow", color: "#2563EB", offset: { x: 0, y: 4 }, blur: 8, enabled: true, tokenId: token.id }
      ]
    } as RectElement;
    let doc = docWith([rect]);
    doc = addTokenToDoc(doc, token);

    doc = removeTokenFromDoc(doc, token.id);

    const updatedRect = getActivePage(doc).children[0] as RectElement;
    const effect = updatedRect.effects?.[0] as DropShadowEffect;
    expect(effect.color).toBe("#2563EB");
    expect(effect.tokenId).toBeUndefined();
  });
});

describe("reorderColorTokens", () => {
  it("moves a colour token among tokens, and leaves the other token type at its indices", () => {
    const t1 = createColorToken("t1", "#111111");
    const t2 = createColorToken("t2", "#222222");
    const t3 = createColorToken("t3", "#333333");
    const number = createNumberToken("space/4", 16, "spacing");
    const tokens = [t1, number, t2, t3];

    // Move t3 (last colour) before t1 (first colour).
    const reordered = reorderColorTokens(colorTokensOf(tokens), 2, 0);
    expect(reordered.map((t) => t.id)).toEqual([t3.id, t1.id, t2.id]);
    expect(mergeTokenOrder(tokens, reordered).map((t) => t.id)).toEqual([
      t3.id,
      number.id,
      t1.id,
      t2.id
    ]);
  });
});

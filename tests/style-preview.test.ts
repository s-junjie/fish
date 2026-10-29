import { describe, it, expect } from "vitest";
import type { DesignDocument, PaintStyle, RectElement, TextElement } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/types";
import {
  createPaintStyle,
  createTextStyle,
  previewStyleInDoc
} from "../src/core/interactions/style-ops";

const canvas = {
  width: 800,
  height: 600,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#000" }
};

function docWith(children: any[]): DesignDocument {
  return {
    id: "d",
    version: "0.1",
    name: "d",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas,
    pages: [{ id: "p", name: "P", canvas, children }],
    activePageId: "p"
  } as DesignDocument;
}

const rect = (extra: Partial<RectElement> = {}): RectElement => ({
  id: "r1",
  type: "rect",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fills: [{ type: "solid", color: "#FF0000" }],
  ...extra
});

/**
 * The live preview an open style editor shows is the save path's materialisation,
 * run without an undo step. What this suite grades is the materialisation: a draft
 * that reached the table but not the layers is exactly the "the canvas does not
 * move until I press Save" this exists to prevent.
 */
describe("a draft style previewed into the document", () => {
  it("rewrites the layers that wear an existing style", () => {
    const style = createPaintStyle("Orange", [{ type: "solid", color: "#FF8800" }]);
    const doc = docWith([rect({ fillStyleId: style.id, fills: style.paints })]);
    doc.styles = [style];

    const drafted: PaintStyle = { ...style, paints: [{ type: "solid", color: "#00FF00" }] };
    const previewed = previewStyleInDoc(doc, drafted);

    expect((previewed.styles?.[0] as PaintStyle).paints[0]).toEqual({ type: "solid", color: "#00FF00" });
    const el = getActivePage(previewed).children[0] as RectElement;
    expect(el.fillStyleId).toBe(style.id);
    expect(el.fills?.[0]).toEqual({ type: "solid", color: "#00FF00" });
    // The document handed in is untouched: a cancel restores it by identity.
    expect(doc.styles?.[0]).toBe(style);
    expect((getActivePage(doc).children[0] as RectElement).fills?.[0]).toEqual({
      type: "solid",
      color: "#FF8800"
    });
  });

  it("adds a style that does not exist yet, and binds the selection a save would bind", () => {
    const doc = docWith([rect()]);
    const draft = createPaintStyle("Brand", [{ type: "solid", color: "#123456" }]);

    const previewed = previewStyleInDoc(doc, draft, ["r1"]);

    expect(previewed.styles?.some((s) => s.id === draft.id)).toBe(true);
    const el = getActivePage(previewed).children[0] as RectElement;
    expect(el.fillStyleId).toBe(draft.id);
    expect(el.fills?.[0]).toEqual({ type: "solid", color: "#123456" });
    // Nothing to bind: the row still lands, but the tree is left alone.
    const unbound = previewStyleInDoc(doc, draft);
    expect(unbound.styles?.some((s) => s.id === draft.id)).toBe(true);
    expect(getActivePage(unbound).children[0]).toBe(getActivePage(doc).children[0]);
  });

  it("binds a type draft to the selected text layer", () => {
    const text: TextElement = {
      id: "t1",
      type: "text",
      x: 0,
      y: 0,
      width: 200,
      height: 24,
      content: "Hello",
      style: { fontFamily: "Inter", fontSize: 12, color: "#000000" }
    };
    const doc = docWith([text]);
    const draft = createTextStyle("Body", { fontFamily: "Inter", fontSize: 32 });

    const previewed = previewStyleInDoc(doc, draft, ["t1"]);
    const el = getActivePage(previewed).children[0] as TextElement;
    expect(el.textStyleId).toBe(draft.id);
    expect(el.style.fontSize).toBe(32);
  });

  it("paints the token's value, not the colour the draft was seeded with", () => {
    const token = { id: "tok_primary", name: "Primary", type: "color" as const, value: "#112233" };
    const style = createPaintStyle("Surface", [
      { type: "solid", color: "#FF0000", tokenId: token.id }
    ]);
    const doc = docWith([rect({ fillStyleId: style.id, fills: style.paints })]);
    doc.styles = [style];
    doc.tokens = [token];

    const previewed = previewStyleInDoc(doc, style);
    const el = getActivePage(previewed).children[0] as RectElement;
    expect(el.fills?.[0]).toEqual({ type: "solid", color: "#112233", tokenId: token.id });
  });
});

import { describe, expect, it } from "vitest";
import { bindStylesByValue } from "../src/core/import/style-binding";
import type { DesignElement, EffectStyle, PaintStyle, TextStyleDefinition } from "../src/core/dsl/types";

const paintStyle = (id: string, color: string): PaintStyle => ({
  id,
  name: id,
  styleType: "paint",
  paints: [{ type: "solid", color }]
});

const rect = (id: string, color: string): DesignElement =>
  ({ id, type: "rect", name: id, x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color }] }) as DesignElement;

describe("bindStylesByValue", () => {
  it("binds a fill that already equals a paint style", () => {
    const { elements, bound } = bindStylesByValue([rect("a", "#FF0000")], [paintStyle("s1", "#FF0000")]);
    expect(bound).toBe(1);
    expect(elements[0].fillStyleId).toBe("s1");
  });

  it("leaves a fill that matches nothing alone", () => {
    const { elements, bound } = bindStylesByValue([rect("a", "#00FF00")], [paintStyle("s1", "#FF0000")]);
    expect(bound).toBe(0);
    expect(elements[0].fillStyleId).toBeUndefined();
  });

  it("matches across key order and absent keys, which CSS and a hand-authored style disagree on", () => {
    const el = {
      id: "a",
      type: "rect",
      name: "a",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fills: [{ color: "#FF0000", type: "solid", opacity: undefined }]
    } as unknown as DesignElement;
    const { elements } = bindStylesByValue([el], [paintStyle("s1", "#FF0000")]);
    expect(elements[0].fillStyleId).toBe("s1");
  });

  it("keeps the local stack equal to the style, so the dual-storage invariant holds", () => {
    const { elements } = bindStylesByValue([rect("a", "#FF0000")], [paintStyle("s1", "#FF0000")]);
    expect(elements[0].fills).toEqual([{ type: "solid", color: "#FF0000" }]);
  });

  it("binds an effect style only when the whole stack is equal", () => {
    const style: EffectStyle = {
      id: "e1",
      name: "e1",
      styleType: "effect",
      effects: [{ type: "drop-shadow", color: "#000000", offset: { x: 0, y: 2 }, blur: 4, enabled: true }]
    };
    const same = {
      id: "a",
      type: "rect",
      name: "a",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      effects: [{ type: "drop-shadow", color: "#000000", offset: { x: 0, y: 2 }, blur: 4, enabled: true }]
    } as unknown as DesignElement;
    const other = { ...same, id: "b", effects: [{ ...same.effects![0], blur: 9 }] } as unknown as DesignElement;

    const { elements, bound } = bindStylesByValue([same, other], [style]);
    expect(bound).toBe(1);
    expect(elements[0].effectStyleId).toBe("e1");
    expect(elements[1].effectStyleId).toBeUndefined();
  });

  it("never binds a text style — the canvas does not resolve textStyleId", () => {
    const textStyle: TextStyleDefinition = {
      id: "t1",
      name: "t1",
      styleType: "text",
      style: { fontFamily: "Inter", fontSize: 14 }
    };
    const el = {
      id: "a",
      type: "text",
      name: "a",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      content: "hi",
      style: { fontFamily: "Inter", fontSize: 14 },
      fills: [{ type: "solid", color: "#FF0000" }]
    } as unknown as DesignElement;
    const { elements } = bindStylesByValue([el], [textStyle]);
    expect((elements[0] as { textStyleId?: string | null }).textStyleId).toBeUndefined();
    expect(elements[0].fillStyleId).toBeUndefined();
  });

  it("prefers the document's first style when two hold the same value", () => {
    const { elements } = bindStylesByValue([rect("a", "#FF0000")], [paintStyle("first", "#FF0000"), paintStyle("second", "#FF0000")]);
    expect(elements[0].fillStyleId).toBe("first");
  });

  it("visits children", () => {
    const frame = {
      id: "f",
      type: "frame",
      name: "f",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [rect("a", "#FF0000")]
    } as unknown as DesignElement;
    const { elements, bound } = bindStylesByValue([frame], [paintStyle("s1", "#FF0000")]);
    expect(bound).toBe(1);
    expect((elements[0] as { children: DesignElement[] }).children[0].fillStyleId).toBe("s1");
  });

  it("returns the tree untouched and binds nothing when the document has no styles", () => {
    const input = [rect("a", "#FF0000")];
    const { elements, bound } = bindStylesByValue(input, []);
    expect(bound).toBe(0);
    expect(elements).toBe(input);
  });

  /**
   * A layer the page wrote as `var(--x)` carries the token it named. Matching it
   * to a style that happens to hold the same colour would give one layer two
   * bindings, which disagree the moment either is edited.
   */
  it("leaves a fill that is already bound to a token alone", () => {
    const el = {
      id: "a",
      type: "rect",
      name: "a",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fills: [{ type: "solid", color: "#FF0000", tokenId: "style_token" }]
    } as unknown as DesignElement;
    const { elements, bound } = bindStylesByValue([el], [paintStyle("s1", "#FF0000")]);
    expect(bound).toBe(0);
    expect(elements[0].fillStyleId).toBeUndefined();
    expect(elements[0].fills?.[0].tokenId).toBe("style_token");
  });

  it("leaves a stroke that is already bound to a token alone", () => {
    const el = {
      id: "a",
      type: "rect",
      name: "a",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      strokes: [{ color: "#FF0000", width: 3, tokenId: "style_token" }]
    } as unknown as DesignElement;
    const { elements, bound } = bindStylesByValue([el], [paintStyle("s1", "#FF0000")]);
    expect(bound).toBe(0);
    expect(elements[0].strokeStyleId).toBeUndefined();
  });

  it("does not invent a fill for an element that has none", () => {
    const el = { id: "a", type: "frame", name: "a", x: 0, y: 0, width: 10, height: 10 } as unknown as DesignElement;
    const { elements, bound } = bindStylesByValue([el], [paintStyle("s1", "#FF0000")]);
    expect(bound).toBe(0);
    expect(elements[0].fillStyleId).toBeUndefined();
  });
});

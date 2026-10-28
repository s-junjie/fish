import { describe, it, expect } from "vitest";
import { reconDocument } from "../src/core/cli/fish-brief";
import type { DesignDocument, DesignElement, PaintStyle, RectElement, TextStyleDefinition } from "../src/core/dsl/types";

/**
 * A style nothing binds is a style the document does not have, and a layer
 * carrying literals is a layer the system never reached. brief is where an
 * agent sees either, so the counts are the contract. They read the stored
 * tree: a master's children count, an instance's painted clones do not, and
 * the override that repaints a clone does.
 */

const rect = (id: string, extra: Partial<RectElement> = {}): RectElement =>
  ({ id, type: "rect", x: 0, y: 0, width: 10, height: 10, ...extra } as RectElement);

const text = (id: string, extra: Record<string, unknown> = {}): DesignElement =>
  ({ id, type: "text", x: 0, y: 0, content: "x", ...extra } as unknown as DesignElement);

const doc = (elements: DesignElement[], styles: DesignDocument["styles"] = []): DesignDocument =>
  ({
    version: "0.1",
    id: "d",
    name: "d",
    createdAt: "",
    updatedAt: "",
    canvas: { width: 100, height: 100 },
    pages: [{ id: "page_1", name: "Page 1", canvas: { width: 100, height: 100 }, children: elements }],
    activePageId: "page_1",
    ...(styles.length ? { styles } : {})
  } as unknown as DesignDocument);

const paintStyle = (id: string, name: string): PaintStyle => ({ id, name, styleType: "paint", paints: [] });
const textStyle = (id: string, name: string): TextStyleDefinition => ({
  id,
  name,
  styleType: "text",
  style: { fontFamily: "Inter", fontSize: 16 }
});

const master = (children: DesignElement[]): DesignElement =>
  ({ id: "comp_btn", type: "component", x: 0, y: 0, children } as unknown as DesignElement);

describe("reconDocument — style wiring", () => {
  it("counts the layers each style binds", () => {
    const r = reconDocument(
      doc(
        [rect("a", { fillStyleId: "sty_card" }), rect("b", { fillStyleId: "sty_card" }), text("t1", { textStyleId: "ts_body" })],
        [paintStyle("sty_card", "surface/card"), textStyle("ts_body", "ts/body")]
      )
    );
    expect(r.styles).toEqual([
      { id: "sty_card", name: "surface/card", styleType: "paint", bound: 2 },
      { id: "ts_body", name: "ts/body", styleType: "text", bound: 1 }
    ]);
    expect(r.styleGaps).toEqual({ paint: 0, text: 0, stroke: 0, effect: 0 });
  });

  it("reports a style nothing binds as bound to zero layers", () => {
    const r = reconDocument(doc([rect("a")], [paintStyle("sty_card", "surface/card")]));
    expect(r.styles[0].bound).toBe(0);
  });

  it("counts the stored layers still carrying literals, per kind", () => {
    const r = reconDocument(
      doc([
        rect("a", { fills: [{ type: "solid", color: "#FFFFFF" }] }),
        text("t1"),
        rect("b", { strokes: [{ color: "#000000", width: 1 }] }),
        rect("c", { effects: [{ type: "layer-blur", blur: 4 }] }),
        rect("d", { strokes: [{ color: "#000000", width: 1 }] })
      ])
    );
    // Both `b` and `d` carry a stroke with a literal colour: a row has no style
    // pointer any more, so each one is a gap.
    expect(r.styleGaps).toEqual({ paint: 1, text: 1, stroke: 2, effect: 1 });
  });

  it("does not count a layer with no paint as one missing a style", () => {
    const r = reconDocument(doc([rect("a"), rect("b", { fills: [] })]));
    expect(r.styleGaps.paint).toBe(0);
  });

  it("counts bindings inside a master, since every instance renders them", () => {
    const r = reconDocument(doc([master([rect("btn_rect", { fillStyleId: "sty_card" })])], [paintStyle("sty_card", "surface/card")]));
    expect(r.styles[0].bound).toBe(1);
  });

  it("counts an instance's style override, which is stored while its clone is not", () => {
    const instance = {
      id: "inst_1",
      type: "instance",
      componentId: "comp_btn",
      x: 0,
      y: 0,
      overrides: [{ targetId: "btn_rect", property: "fillStyleId", value: "sty_alt" }]
    } as unknown as DesignElement;
    const r = reconDocument(
      doc([master([rect("btn_rect", { fillStyleId: "sty_card" })]), instance], [paintStyle("sty_card", "surface/card"), paintStyle("sty_alt", "surface/alt")])
    );
    expect(r.styles.map((s) => s.bound)).toEqual([1, 1]);
  });

  it("ignores an override that unbinds, since null points at no style", () => {
    const instance = {
      id: "inst_1",
      type: "instance",
      componentId: "comp_btn",
      x: 0,
      y: 0,
      overrides: [{ targetId: "btn_rect", property: "fillStyleId", value: null }]
    } as unknown as DesignElement;
    const r = reconDocument(doc([master([rect("btn_rect", { fillStyleId: "sty_card" })]), instance], [paintStyle("sty_card", "surface/card")]));
    expect(r.styles[0].bound).toBe(1);
  });

  it("separates a token-bound layer from one carrying literals", () => {
    const r = reconDocument(
      doc([
        rect("a", { fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_surface" } as never] }),
        rect("b", { fills: [{ type: "solid", color: "#FFFFFF" }] })
      ])
    );
    // A colour from a token IS the system working: a single colour is never a
    // paint style, so calling it drift sent the agent looking for a style to
    // bind where the right answer was already there.
    expect(r.styleGaps.paint).toBe(1);
    expect(r.tokenBound.paint).toBe(1);
  });

  it("reads a token on a gradient stop, a stroke row and an effect as bound", () => {
    const r = reconDocument(
      doc([
        rect("a", {
          fills: [
            { type: "linear-gradient", angle: 90, stops: [{ color: "#FFFFFF", offset: 0, tokenId: "tok_surface" }] }
          ]
        } as never),
        rect("b", { strokes: [{ color: "#000000", width: 1, tokenId: "tok_line" }] } as never),
        rect("c", { effects: [{ type: "layer-blur", blur: 4, tokenBindings: { blur: "tok_blur" } }] } as never),
        text("t1", { tokenBindings: { fontSize: "tok_body" } })
      ])
    );
    expect(r.styleGaps).toEqual({ paint: 0, text: 0, stroke: 0, effect: 0 });
    expect(r.tokenBound).toEqual({ paint: 1, text: 1, stroke: 1, effect: 1 });
  });
});

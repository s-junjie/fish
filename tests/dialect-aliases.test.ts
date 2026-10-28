import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { getActivePage } from "../src/core/dsl/types";
import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * The dialect's canonical spellings, and the Figma/CSS spellings the normalizer
 * absorbs on the way in.
 *
 * A page's list is `children`, the same word a frame uses, because a page IS a
 * container. `pages[i].elements` was the pre-rename spelling and is refused: v1
 * has no documents written against it, and adopting it silently is what makes a
 * mistyped page indistinguishable from an empty one.
 *
 * The other aliases are the names a model reaches for when it has Figma or CSS
 * in mind: `clipsContent`, `overflow: "hidden"`, `characters`, `layoutGrow`,
 * `flex`, and an outer-level `padding`. Each is read and each
 * reports a repair, because a key that is silently dropped is indistinguishable
 * from one that worked.
 */

const canvas = { width: 800, height: 600, background: { type: "solid", color: "#FFFFFF" } };

const page = (elements: unknown[]): DesignDocument =>
  ({
    docId: "d",
    version: "0.1",
    name: "n",
    canvas,
    pages: [{ id: "p1", name: "P1", canvas, children: elements }],
    activePageId: "p1"
  }) as unknown as DesignDocument;

const first = (input: unknown): DesignElement => normalizeDesignDocument(input).document.pages[0].children[0];

const repaired = (input: unknown, needle: string): boolean =>
  normalizeDesignDocument(input).repairs.some((r) => r.path.includes(needle) || r.message.includes(needle));

const frame = (over: Record<string, unknown> = {}) => ({ type: "frame", width: 100, height: 100, ...over });

const asContainer = (el: DesignElement) =>
  el as unknown as { children?: DesignElement[]; layout?: { padding?: unknown } };

const prop = (el: DesignElement, key: string): unknown => (el as unknown as Record<string, unknown>)[key];

describe("page.children is the canonical page list", () => {
  it("refuses the pre-rename page `elements` list, and says so", () => {
    const input = {
      version: "0.1",
      canvas,
      pages: [{ id: "p1", name: "P1", canvas, elements: [{ id: "a", type: "rect", width: 4, height: 4 }] }],
      activePageId: "p1"
    };
    const { document, repairs } = normalizeDesignDocument(input);

    expect(document.pages[0].children).toHaveLength(0);
    expect((document.pages[0] as unknown as Record<string, unknown>).elements).toBeUndefined();
    expect(
      repairs.some(
        (r) => r.kind === "dropped-property" && r.path === "/pages/0/elements"
      )
    ).toBe(true);
  });

  it("adopts a document-level `elements` array into the first page, and writes none back", () => {
    const { document } = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 100, height: 100 },
      elements: [frame({ id: "a" })]
    } as never);
    expect(getActivePage(document).children).toHaveLength(1);
    expect((document as unknown as Record<string, unknown>).elements).toBeUndefined();
  });
});

describe("clipContent absorbs Figma and CSS spellings", () => {
  it("reads Figma `clipsContent` without calling it a repair", () => {
    const el = first(page([frame({ clipsContent: true })]));
    expect(prop(el, "clipContent")).toBe(true);
    expect(repaired(page([frame({ clipsContent: true })]), "clipsContent")).toBe(false);
  });

  it("reads CSS `overflow: \"hidden\"` as a first-class spelling", () => {
    // `overflow` is what the writer emits, so a document that round-trips
    // through the workbench must come back with no repairs at all.
    const el = first(page([frame({ overflow: "hidden" })]));
    expect(prop(el, "clipContent")).toBe(true);
    expect(repaired(page([frame({ overflow: "hidden" })]), "overflow")).toBe(false);
  });

  it("reads a bare `clip` boolean", () => {
    const el = first(page([frame({ clip: true })]));
    expect(prop(el, "clipContent")).toBe(true);
  });

  it("does not turn a visible overflow into clipping", () => {
    const el = first(page([frame({ overflow: "visible" })]));
    expect(prop(el, "clipContent")).not.toBe(true);
  });

  it("reports two spellings that disagree rather than picking silently", () => {
    expect(repaired(page([frame({ overflow: "visible", clipContent: true })]), "overflow")).toBe(true);
    expect(prop(first(page([frame({ overflow: "visible", clipContent: true })])), "clipContent")).toBe(true);
  });
});

describe("text absorbs Figma and CSS spellings for its content", () => {
  const text = (over: Record<string, unknown>) => ({ id: "t", type: "text", ...over });

  it("reads Figma `characters`", () => {
    const el = first(page([text({ characters: "Hello" })]));
    expect(prop(el, "content")).toBe("Hello");
    expect(repaired(page([text({ characters: "Hello" })]), "characters")).toBe(true);
  });
});

describe("layoutGrow and flex resolve onto the parent's main axis", () => {
  const child = () => ({ id: "c", type: "rect", width: 20, height: 20, layoutGrow: 1 });

  it("fills width in a row parent", () => {
    const el = first(page([frame({ ...flattenLayout({ mode: "flex", direction: "row" }), children: [child()] })]));
    expect(asContainer(el).children?.[0].sizing?.width).toBe("fill");
  });

  it("fills height in a column parent", () => {
    const el = first(page([frame({ ...flattenLayout({ mode: "flex", direction: "column" }), children: [child()] })]));
    expect(asContainer(el).children?.[0].sizing?.height).toBe("fill");
  });

  it("reports the alias as a repair", () => {
    const input = page([frame({ ...flattenLayout({ mode: "flex", direction: "row" }), children: [child()] })]);
    expect(repaired(input, "layoutGrow")).toBe(true);
  });

  // Only the aliases used to be told. The canonical spellings said nothing, so
  // three spellings of one idea gave two different answers to the same mistake.
  it("reports every spelling when there is no flex parent to fill along", () => {
    for (const key of ["layoutGrow", "flex-grow", "flexGrow"]) {
      const input = page([{ id: "c", type: "rect", width: 20, height: 20, [key]: 1 }]);
      expect(repaired(input, key), key).toBe(true);
    }
  });
});

describe("a top-level padding is the layout's padding", () => {
  it("reads a bare padding as the layout padding", () => {
    const el = first(page([frame({ padding: 16, ...flattenLayout({ mode: "flex", direction: "column" }) })]));
    expect(layoutOf(el)?.padding).toBe(16);
  });

  it("expands the CSS shorthand before storing it", () => {
    const el = first(page([frame({ padding: "1 2 3 4", ...flattenLayout({ mode: "flex", direction: "column" }) })]));
    expect(layoutOf(el)?.padding).toEqual([1, 2, 3, 4]);
  });
});

describe("the CSS background spellings join the fills stack", () => {
  it("reads `background`, `backgroundColor` and `color`", () => {
    expect(prop(first(page([frame({ background: "#00FF00" })])), "fills")).toEqual([
      { type: "solid", color: "#00FF00" }
    ]);
    expect(prop(first(page([frame({ backgroundColor: "#123456" })])), "fills")).toEqual([
      { type: "solid", color: "#123456" }
    ]);
    expect(prop(first(page([frame({ color: "#ABCDEF" })])), "fills")).toEqual([
      { type: "solid", color: "#ABCDEF" }
    ]);
  });

  it("paints a comma-separated `background` bottom-first, the reverse of CSS", () => {
    // CSS paints the FIRST layer on top; the DSL stack is bottom-first, so the
    // layers are pushed in reverse.
    const el = first(page([frame({ background: "linear-gradient(#FFF, #000), #808080" })]));
    const fills = prop(el, "fills") as Array<{ type: string }>;
    expect(fills.map((f) => f.type)).toEqual(["solid", "linear-gradient"]);
  });

  it("lets a real `fills` array win over a stray CSS spelling", () => {
    const el = first(page([frame({ fills: [{ type: "solid", color: "#0000FF" }], color: "#FF0000" })]));
    expect(prop(el, "fills")).toEqual([{ type: "solid", color: "#0000FF" }]);
  });
});

describe("the pre-rename spellings the dialect refuses", () => {
  // Not a compatibility shim: v1 has no documents written against these, so each
  // is a key the engine does not honour. `fish check` normalizes without
  // `preserveUnknown` and therefore reports each as dropped.
  const strict = (input: unknown) => normalizeDesignDocument(input);

  it("refuses the singular `fill`", () => {
    // The CSS spellings above have a source outside FISH; `fill` was FISH's own
    // pre-rename singular and has none, so it is not absorbed into `fills`.
    const input = page([frame({ fill: "#FF0000" })]);
    expect(prop(normalizeDesignDocument(input, { preserveUnknown: true }).document.pages[0].children[0], "fills")).toBeUndefined();
    expect(strict(input).repairs.some((r) => r.message.includes('"fill"'))).toBe(true);
  });

  it("refuses the pre-rename `variant`", () => {
    const input = page([frame({ type: "component", variant: { State: "Hover" } })]);
    expect(prop(normalizeDesignDocument(input, { preserveUnknown: true }).document.pages[0].children[0], "variantProperties")).toBeUndefined();
    expect(strict(input).repairs.some((r) => r.message.includes('"variant"'))).toBe(true);
  });

  it("refuses `textContent`", () => {
    const input = page([{ id: "t", type: "text", textContent: "Hello" }]);
    expect(prop(first(input), "content")).toBe("");
    expect(strict(input).repairs.some((r) => r.message.includes("textContent"))).toBe(true);
  });

  it("refuses `w` and `h`", () => {
    const input = page([{ id: "r", type: "rect", w: 20, h: 10 }]);
    expect(prop(first(input), "width")).toBe(0);
    expect(strict(input).repairs.some((r) => r.message.includes('"w"') || r.message.includes('"h"'))).toBe(true);
  });

  it("refuses element-level effect shortcuts", () => {
    const input = page([frame({ shadow: { blur: 4 }, blur: 6 })]);
    const el = first(input);
    expect(prop(el, "effects")).toBeUndefined();
    expect(strict(input).repairs.some((r) => r.message.includes("shadow"))).toBe(true);
  });

  it("refuses pre-rename effect type spellings", () => {
    const input = page([frame({ effects: [{ type: "background-blur", blur: 4 }] })]);
    expect(prop(first(input), "effects")).toBeUndefined();
  });

  it("refuses paint-level `value` and `fill`", () => {
    const input = page([frame({ fills: [{ type: "solid", value: "#FF0000" }] })]);
    expect(prop(first(input), "fills")).toBeUndefined();
  });

  it("refuses the run-together `multiplyblend`", () => {
    const input = page([frame({ blendMode: "multiplyblend" })]);
    expect(prop(first(input), "blendMode")).toBeUndefined();
    expect(strict(input).repairs.some((r) => r.message.includes("multiplyblend"))).toBe(true);
  });

  it("refuses a `layout` string", () => {
    const input = page([frame({ layout: "col gap=16" })]);
    expect(prop(first(input), "display")).toBeUndefined();
    expect(strict(input).repairs.some((r) => r.path.includes("/layout"))).toBe(true);
  });

  it("refuses the pre-P2 `layoutPosition`", () => {
    const input = page([frame({ layoutPosition: "absolute" })]);
    const el = normalizeDesignDocument(input, { preserveUnknown: true }).document.pages[0].children[0];
    expect(prop(el, "position")).toBeUndefined();
    expect(strict(input).repairs.some((r) => r.message.includes("layoutPosition"))).toBe(true);
  });
});

describe("the stroke-row input spellings fold into the strokes[] row", () => {
  const stroked = (over: Record<string, unknown>) => frame({ borderWidth: 1, ...over });
  const topStroke = (input: unknown) =>
    (first(input) as unknown as { strokes?: Array<Record<string, unknown>> }).strokes?.[0];

  it("reads Figma per-side weights into the row's sides, without a repair", () => {
    // A key the gate reports as an unknown property while the reader applies it
    // is a false repair — the same cost as a silent drop — so this asserts both
    // halves: the value lands, and nothing names the key.
    const input = page([stroked({ strokeTopWeight: 2 })]);
    expect(topStroke(input)?.sides).toEqual({ top: 2, right: 0, bottom: 0, left: 0 });
    expect(repaired(input, "strokeTopWeight")).toBe(false);
  });

  it("reads the kebab spelling of a per-side weight the same way", () => {
    const input = page([stroked({ "stroke-top-weight": 2 })]);
    expect(topStroke(input)?.sides).toEqual({ top: 2, right: 0, bottom: 0, left: 0 });
    expect(repaired(input, "stroke-top-weight")).toBe(false);
  });

  it("reads a sides map under either name", () => {
    for (const key of ["strokeSides", "borderSides"]) {
      const input = page([stroked({ [key]: { top: 2, left: "3px" } })]);
      expect(topStroke(input)?.sides, key).toEqual({ top: 2, right: 0, bottom: 0, left: 3 });
      expect(repaired(input, key), key).toBe(false);
    }
  });

  it("reads a one-side selector under either name", () => {
    for (const key of ["borderSide", "strokeSide"]) {
      const input = page([stroked({ [key]: "top" })]);
      expect(topStroke(input)?.side, key).toBe("top");
      expect(repaired(input, key), key).toBe(false);
    }
  });
});

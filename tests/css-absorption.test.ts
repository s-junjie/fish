import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
/**
 * The normalizer absorbs the CSS spellings an author already writes — flat
 * `display` / `flex-direction` / `justify-content` / `align-items` / `flex-wrap`
 * / `gap` / `padding`, top-level text keys, `align-self`, a CSS-string
 * `border-radius`, and a `width`/`height` that names a sizing mode — while
 * STORAGE stays DSL-named for everything the layout surface did not rename.
 * Both the kebab and the camel spelling resolve to one meaning.
 *
 * The assertion that matters for the generate loop is "no `dropped-property`
 * repair": an absorption repair (`moved into …`) is the engine telling the
 * author where the value went, which is not rework.
 */

import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { normalizeAutoLayout } from "../src/core/dsl/normalize/auto-layout";
import { WIDTH_SIZING_MODES } from "../src/core/dsl/schema-enums";
import { gridColumnCount } from "../src/core/compile";

const child = { id: "c", type: "rect", name: "c", x: 0, y: 0, width: 10, height: 10 };

function frameDoc(extra: Record<string, unknown>) {
  return {
    pages: [{ id: "p1", name: "P", children: [{ id: "f", type: "frame", name: "f", x: 0, y: 0, width: 320, height: 200, children: [child], ...extra }] }],
    activePageId: "p1"
  };
}

function textDoc(extra: Record<string, unknown>) {
  return {
    pages: [{ id: "p1", name: "P", children: [{ id: "t", type: "text", name: "t", x: 0, y: 0, width: 100, height: 24, text: "hi", ...extra }] }],
    activePageId: "p1"
  };
}

const repairsFor = (extra: Record<string, unknown>) =>
  normalizeDesignDocument(frameDoc(extra) as any).repairs;

const only = (doc: any) => doc.pages[0].children[0];
const drops = (repairs: { kind: string; message: string }[]) => repairs.filter((r) => r.kind === "dropped-property");

describe("P0.5 — flat CSS layout spellings are absorbed", () => {
  it("folds camelCase flat keys into layout", () => {
    const out = normalizeDesignDocument(frameDoc({
      display: "flex", flexDirection: "column", justifyContent: "center",
      alignItems: "center", flexWrap: "wrap", gap: 16, padding: 24
    }));
    const layout = layoutOf(only(out.document));
    expect(layout).toMatchObject({ mode: "flex", direction: "column", justify: "center", align: "center", wrap: "wrap", gap: 16, padding: 24 });
    expect(drops(out.repairs)).toEqual([]);
  });

  it("folds the kebab spelling of the same keys", () => {
    const out = normalizeDesignDocument(frameDoc({
      display: "flex", "flex-direction": "row", "justify-content": "space-between",
      "align-items": "center", gap: 8, padding: 16
    }));
    const layout = layoutOf(only(out.document));
    expect(layout).toMatchObject({ mode: "flex", direction: "row", justify: "space-between", align: "center", gap: 8, padding: 16 });
    expect(drops(out.repairs)).toEqual([]);
  });

  it("accepts display: block as no auto-layout, without refusing it", () => {
    const out = normalizeDesignDocument(frameDoc({ display: "block" }));
    expect(layoutOf(only(out.document))).toBeUndefined();
    expect(drops(out.repairs)).toEqual([]);
  });

  it("accepts the CSS spellings of the keys on the element", () => {
    const out = normalizeDesignDocument(frameDoc({ display: "flex", alignItems: "center", justifyContent: "end" }));
    expect(layoutOf(only(out.document))).toMatchObject({ mode: "flex", align: "center", justify: "end" });
    expect(out.repairs.find((r) => r.message.includes("alignItems"))).toBeUndefined();
  });

  it("reports top-level layout keys when there is no display and no layout", () => {
    const out = normalizeDesignDocument(frameDoc({ gap: 16 }));
    expect(drops(out.repairs).some((r) => r.message.includes("gap"))).toBe(true);
  });
});

describe("P0.5 — flat text keys fold into style", () => {
  it("moves fontSize / fontWeight / fontFamily into style", () => {
    const out = normalizeDesignDocument(textDoc({ fontSize: 20, fontWeight: 700, fontFamily: "Inter" }));
    expect(only(out.document).style).toMatchObject({ fontSize: 20, fontWeight: 700, fontFamily: "Inter" });
    expect(drops(out.repairs)).toEqual([]);
  });

  it("moves the kebab spelling too", () => {
    const out = normalizeDesignDocument(textDoc({ "font-size": 20, "line-height": 1.4 }));
    expect(only(out.document).style).toMatchObject({ fontSize: 20, lineHeight: 1.4 });
    expect(drops(out.repairs)).toEqual([]);
  });
});

describe("P0.5 — width/height mode keywords fold into sizing (never a length)", () => {
  it("folds auto / 100% into sizing and leaves a pixel size alone", () => {
    const out = normalizeDesignDocument(frameDoc({ width: "auto", height: "100%" }));
    const el = only(out.document);
    expect(el.sizing).toMatchObject({ width: "fit-content", height: "fill" });
  });

  it("keeps a numeric width as the authored pixel size", () => {
    const out = normalizeDesignDocument(frameDoc({ width: 240 }));
    expect(only(out.document).width).toBe(240);
    expect(only(out.document).sizing?.width).toBeUndefined();
  });

  it("folds every published width mode, not a hand-copied subset", () => {
    for (const mode of WIDTH_SIZING_MODES) {
      const out = normalizeDesignDocument(frameDoc({ width: mode }));
      expect(only(out.document).sizing?.width, mode).toBe(mode);
    }
  });
});

describe("P0.5 — CSS-string border-radius", () => {
  it("parses a px string", () => {
    const out = normalizeDesignDocument(frameDoc({ borderRadius: "8px" }));
    expect(only(out.document).borderRadius).toBe(8);
  });

  it("resolves a percentage against the box", () => {
    const out = normalizeDesignDocument(frameDoc({ width: 100, height: 100, borderRadius: "50%" }));
    expect(only(out.document).borderRadius).toBe(50);
  });
});

describe("P0.5 — align-self absorbs to layoutAlignSelf", () => {
  it("accepts the CSS name on a child of a flex parent", () => {
    const out = normalizeDesignDocument({
      pages: [{ id: "p1", name: "P", children: [{
        id: "f", type: "frame", name: "f", x: 0, y: 0, width: 320, height: 200,
        ...flattenLayout({ mode: "flex" }),
        children: [{ ...child, alignSelf: "center" }]
      }] }],
      activePageId: "p1"
    });
    const c = (out.document.pages[0].children[0] as any).children[0] as any;
    expect(c["align-self"]).toBe("center");
    expect(drops(out.repairs).find((r) => r.message.includes("alignSelf"))).toBeUndefined();
  });
});

describe("P1 — box-sizing and per-side border spellings", () => {
  it("accepts box-sizing: border-box silently and reports content-box", () => {
    const ok = normalizeDesignDocument(frameDoc({ "box-sizing": "border-box" }));
    expect(drops(ok.repairs)).toEqual([]);
    expect(ok.repairs.find((r) => r.message.includes("content-box"))).toBeUndefined();

    const bad = normalizeDesignDocument(frameDoc({ boxSizing: "content-box" }));
    expect(bad.repairs.find((r) => r.message.includes("content-box"))).toBeDefined();
  });

  it("accepts kebab per-side border widths", () => {
    const out = normalizeDesignDocument(
      frameDoc({ "border-top-width": 4, "border-right-width": 0, "border-color": "#000" })
    );
    expect(drops(out.repairs)).toEqual([]);
    const el = only(out.document) as any;
    const stroke = el.strokes?.[0] ?? el.stroke;
    expect(stroke?.sides?.top).toBe(4);
  });
});

describe("CSS alignment recovery — the measured defects", () => {
  it("reads CSS's flex-start / flex-end as start / end", () => {
    const out = normalizeDesignDocument(frameDoc({
      display: "flex", "justify-content": "flex-start", "align-items": "flex-end", "align-content": "flex-start"
    }));
    expect(layoutOf(only(out.document))).toMatchObject({ justify: "start", align: "end", alignContent: "start" });
    expect(drops(out.repairs)).toEqual([]);
  });

  it("accepts the per-axis gap keys in kebab, on the element", () => {
    const out = normalizeDesignDocument(frameDoc({ display: "flex", "row-gap": 8, "column-gap": 12 }));
    expect(layoutOf(only(out.document))).toMatchObject({ rowGap: 8, columnGap: 12 });
    expect(out.repairs.find((r) => r.message.includes("unknown layout property"))).toBeUndefined();
  });

  it("reads grid display on the element", () => {
    const out = normalizeDesignDocument(frameDoc({ display: "grid", "grid-template-columns": 2 }));
    expect(layoutOf(only(out.document))).toMatchObject({ mode: "grid", columns: 2 });
  });

  it("accepts align-content: stretch in the nested layout", () => {
    const out = normalizeDesignDocument(frameDoc({ ...flattenLayout({ mode: "flex", wrap: "wrap", alignContent: "stretch" }) }));
    expect(layoutOf(only(out.document))).toMatchObject({ alignContent: "stretch" });
  });

  it("refuses a layout string instead of expanding it", () => {
    const out = normalizeDesignDocument(frameDoc({ layout: "colmun gap=16" }));
    expect(layoutOf(only(out.document))).toBeUndefined();
    expect(out.repairs.some((r) => r.path.includes("/layout"))).toBe(true);
  });

  it("reports element-level alpha rather than silently ignoring it", () => {
    const out = normalizeDesignDocument(frameDoc({ alpha: 0.5 }));
    expect(out.repairs.some((r) => r.message.includes("alpha"))).toBe(true);
  });

  it("reads a CSS flex shorthand string's first number as flexGrow", () => {
    const out = normalizeDesignDocument({
      pages: [{ id: "p1", name: "P", children: [{
        id: "f", type: "frame", name: "f", x: 0, y: 0, width: 300, height: 100,
        ...flattenLayout({ mode: "flex", direction: "row" }),
        children: [{ ...child, flex: "2 1 0" }]
      }] }],
      activePageId: "p1"
    });
    const c = (out.document.pages[0].children[0] as any).children[0] as any;
    expect(c["flex-grow"]).toBe(2);
  });

  it("drops a container font (no inheritance) with a note", () => {
    const out = normalizeDesignDocument(frameDoc({ fontSize: 20 }));
    expect(drops(out.repairs).some((r) => r.message.includes("fontSize"))).toBe(true);
  });
});

describe("a layout spelling cannot skip the mode gate its camel twin passes", () => {
  const gridOnly: Array<[string, Record<string, unknown>]> = [
    ["cellAlign", { mode: "flex", cellAlign: "center" }],
    ["cell-align", { mode: "flex", "cell-align": "center" }],
    ["columnsMode", { mode: "flex", columnsMode: "auto" }],
    ["columns-mode", { mode: "flex", "columns-mode": "auto" }],
    ["columnWidthMin", { mode: "flex", columnWidthMin: 120 }],
    ["column-width-min", { mode: "flex", "column-width-min": 120 }],
    ["columnSizes", { mode: "flex", columnSizes: [1, 2] }],
    ["column-sizes", { mode: "flex", "column-sizes": [1, 2] }]
  ];
  const flexOnly: Array<[string, Record<string, unknown>]> = [
    ["justify", { mode: "grid", justify: "center" }],
    ["justify-content", { mode: "grid", "justify-content": "center" }],
    ["direction", { mode: "grid", direction: "row" }],
    ["flex-direction", { mode: "grid", "flex-direction": "row" }],
    ["align", { mode: "grid", align: "center" }],
    ["align-items", { mode: "grid", "align-items": "center" }],
    ["alignContent", { mode: "grid", alignContent: "center" }],
    ["align-content", { mode: "grid", "align-content": "center" }],
    ["wrap", { mode: "grid", wrap: "wrap" }],
    ["flex-wrap", { mode: "grid", "flex-wrap": "wrap" }]
  ];

  it.each(gridOnly)("reports %s on a flex layout", (spelling, layout) => {
    const repairs: any[] = [];
    normalizeAutoLayout(layout, "/layout", repairs);
    const hit = repairs.find((r) => r.path.endsWith(`/${spelling}`) && r.message.includes("only applies to grid"));
    expect(hit, `no grid-mode gate for "${spelling}" in ${JSON.stringify(repairs)}`).toBeDefined();
  });

  it.each(flexOnly)("reports %s on a grid layout", (spelling, layout) => {
    const repairs: any[] = [];
    normalizeAutoLayout(layout, "/layout", repairs);
    const hit = repairs.find((r) => r.path.endsWith(`/${spelling}`) && r.message.includes("only applies to Stack"));
    expect(hit, `no flex-mode gate for "${spelling}" in ${JSON.stringify(repairs)}`).toBeDefined();
  });
});

describe("unknown-key hints come from the vocabulary tables", () => {
  it("points a stray flat layout key at the flat key that means it", () => {
    const repairs = repairsFor({ columns: 3 });
    const hit = repairs.find((r) => r.message.includes('unknown property "columns"'));
    expect(hit?.message).toContain("grid-template-columns");
  });

  it("does not offer a style.* hint on a frame, which has no style", () => {
    const repairs = repairsFor({ fontSize: 20 });
    const hit = repairs.find((r) => r.message.includes('unknown property "fontSize"'));
    expect(hit?.message).not.toContain("style.");
  });
});

describe("P0.5 — element-level CSS keys are absorbed too", () => {
  const withChild = (childExtra: Record<string, unknown>) => ({
    pages: [{
      id: "p1",
      name: "P",
      children: [{
        id: "f", type: "frame", name: "f", x: 0, y: 0, width: 320, height: 200,
        ...flattenLayout({ mode: "flex", direction: "column" }),
        children: [{ ...child, ...childExtra }]
      }]
    }],
    activePageId: "p1"
  });
  const childOf = (out: { document: any }) => out.document.pages[0].children[0].children[0];

  it("reads a flat position as layoutPosition", () => {
    const out = normalizeDesignDocument(withChild({ position: "absolute" }) as any);
    expect(childOf(out).position).toBe("absolute");
    expect(drops(out.repairs)).toEqual([]);
  });

  it("reads a flat margin as layoutMargin", () => {
    const out = normalizeDesignDocument(withChild({ margin: 8 }) as any);
    expect(childOf(out).margin).toBe(8);
    expect(drops(out.repairs)).toEqual([]);
  });

  it("reads a flat flex-grow as flexGrow (sizing fill on the parent's main axis)", () => {
    const out = normalizeDesignDocument(withChild({ "flex-grow": 2 }) as any);
    expect(childOf(out)["flex-grow"]).toBe(2);
    expect(childOf(out).sizing?.height).toBe("fill");
    expect(drops(out.repairs)).toEqual([]);
  });
});

describe("P2 flat layout & CSS alignment regressions", () => {
  it("keeps ellipse arc gap without reporting it as a layout gap without display", () => {
    const out = normalizeDesignDocument({
      pages: [{
        id: "p1",
        name: "P",
        children: [{
          id: "arc",
          type: "ellipse",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          innerRadius: 0.75,
          startAngle: 0,
          sweep: 120,
          gap: 2,
          fills: [{ type: "solid", color: "#3B82F6" }]
        }]
      }],
      activePageId: "p1"
    } as any);
    expect(only(out.document).gap).toBe(2);
    expect(drops(out.repairs)).toEqual([]);
  });

  it("reports legacy flat direction / justify / align aliases with suggestions", () => {
    const out = normalizeDesignDocument(frameDoc({
      display: "flex",
      direction: "row",
      justify: "space-between",
      align: "center"
    }));
    expect(drops(out.repairs).some((r) => r.message.includes("flex-direction"))).toBe(true);
    expect(drops(out.repairs).some((r) => r.message.includes("justify-content"))).toBe(true);
    expect(drops(out.repairs).some((r) => r.message.includes("align-items"))).toBe(true);
  });

  it("routes align-items on display: inline-grid to cellAlign rather than flex align", () => {
    const out = normalizeDesignDocument(frameDoc({
      display: "inline-grid",
      "grid-template-columns": 3,
      "align-items": "center"
    }));
    expect(layoutOf(only(out.document))).toMatchObject({
      mode: "grid",
      columns: 3,
      cellAlign: "center"
    });
    expect(out.repairs.filter((r) => r.severity !== "info")).toEqual([]);
  });

  it("parses CSS string values on grid-template-columns and grid-template-rows", () => {
    const tracksOut = normalizeDesignDocument(frameDoc({
      display: "grid",
      "grid-template-columns": "240px 1fr 2fr",
      "grid-template-rows": "repeat(2, 80px)"
    }));
    expect(layoutOf(only(tracksOut.document))).toMatchObject({
      mode: "grid",
      columnSizes: [240, { fr: 1 }, { fr: 2 }],
      rowSizes: [80, 80]
    });
    expect(tracksOut.repairs.filter((r) => r.severity !== "info")).toEqual([]);

    const repeatOut = normalizeDesignDocument(frameDoc({
      display: "grid",
      "grid-template-columns": "repeat(3, minmax(0, 1fr))"
    }));
    expect(layoutOf(only(repeatOut.document))).toMatchObject({
      mode: "grid",
      columnSizes: [{ fr: 1 }, { fr: 1 }, { fr: 1 }]
    });
    expect(repeatOut.repairs.filter((r) => r.severity !== "info")).toEqual([]);

    const autoFitOut = normalizeDesignDocument(frameDoc({
      display: "grid",
      "grid-template-columns": "repeat(auto-fit, minmax(220px, 1fr))"
    }));
    expect(layoutOf(only(autoFitOut.document))).toMatchObject({
      mode: "grid",
      columnsMode: "auto",
      columnWidthMin: 220
    });
    expect(autoFitOut.repairs.filter((r) => r.severity !== "info")).toEqual([]);

    const autoFillOut = normalizeDesignDocument(frameDoc({
      display: "grid",
      "grid-template-columns": "repeat(auto-fill, minmax(280px, 1fr))"
    }));
    const autoFillLayout = layoutOf(only(autoFillOut.document))!;
    expect(autoFillLayout).toMatchObject({
      mode: "grid",
      columnsMode: "auto",
      columnWidthMin: 280
    });
    expect(gridColumnCount(autoFillLayout, 1440)).toBe(5);
    expect(autoFillOut.repairs.filter((r) => r.severity !== "info")).toEqual([]);
  });

  it("reports unsupported track units or invalid shapes in grid-template-columns instead of dropping silently", () => {
    const badTrack = normalizeDesignDocument(frameDoc({
      display: "grid",
      "grid-template-columns": "1fr 50%"
    }));
    expect(badTrack.repairs.some((r) => r.message.includes("50%"))).toBe(true);

    const badType = normalizeDesignDocument(frameDoc({
      display: "grid",
      "grid-template-columns": true
    }));
    expect(badType.repairs.some((r) => r.message.includes("columnSizes"))).toBe(true);
  });

  it("accepts kebab and top-level min-width / max-width / min-height / max-height bounds", () => {
    const topLevel = normalizeDesignDocument(frameDoc({
      width: "100%",
      "min-width": 200,
      "max-width": "37.5rem",
      "min-height": 80,
      "max-height": 400
    }));
    expect(only(topLevel.document).sizing).toMatchObject({
      width: "fill",
      minWidth: 200,
      maxWidth: 600,
      minHeight: 80,
      maxHeight: 400
    });
    expect(drops(topLevel.repairs)).toEqual([]);

    const inSizing = normalizeDesignDocument(frameDoc({
      sizing: { width: "fill", "min-width": 160, "max-width": 480 }
    }));
    expect(only(inSizing.document).sizing).toMatchObject({
      width: "fill",
      minWidth: 160,
      maxWidth: 480
    });
    expect(inSizing.repairs.filter((r) => r.severity !== "info")).toEqual([]);
  });

  it("treats onPath.startOffset as a path-length percentage (0-100 or %) and rejects px/rem units", () => {
    const pct = normalizeDesignDocument(textDoc({
      onPath: { pathId: "p_ring", startOffset: "50%" }
    }));
    expect(only(pct.document).onPath).toMatchObject({ pathId: "p_ring", startOffset: 50 });
    expect(pct.repairs.filter((r) => r.severity !== "info")).toEqual([]);

    const pxBad = normalizeDesignDocument(textDoc({
      onPath: { pathId: "p_ring", startOffset: "20px" }
    }));
    expect(pxBad.repairs.some((r) => r.path.endsWith("/onPath/startOffset"))).toBe(true);
  });
});

/**
 * The rest of the authored CSS surface: the text keys that exist only under
 * `style`, compositing, and image fit. All three were read a level down but
 * rejected at the top level — a concept the DSL had, spelled the way the rest of
 * the file is spelled, refused at exactly the surface an author writes on.
 */
describe("authored CSS — the keys that had no element-level spelling", () => {
  const imageFill = { type: "image", assetId: "a1" };

  it("folds the top-level text keys CSS spells into style", () => {
    for (const [key, target, value] of [
      ["vertical-align", "verticalAlign", "middle"],
      ["text-shadow", "textShadow", "0 1px 2px #000"],
      ["font-variant-numeric", "fontVariantNumeric", "tabular-nums"]
    ] as const) {
      const out = normalizeDesignDocument(textDoc({ [key]: value, maxLines: 2 }));
      if (target === "textShadow") {
        // One shadow, one home: the CSS string becomes an effect and is not
        // stored on `style` at all.
        expect(only(out.document).style?.textShadow, key).toBeUndefined();
        expect(only(out.document).effects?.[0]?.type, key).toBe("drop-shadow");
      } else {
        expect(only(out.document).style?.[target], key).toBe(value);
      }
      expect(drops(out.repairs), key).toEqual([]);
    }
  });

  it("accepts every spelling of line-clamp, including the one shipping sites write", () => {
    for (const key of ["line-clamp", "-webkit-line-clamp", "webkitLineClamp"]) {
      const out = normalizeDesignDocument(textDoc({ [key]: 3 }));
      expect(only(out.document).style?.maxLines, key).toBe(3);
      expect(drops(out.repairs), key).toEqual([]);
    }
  });

  it("keeps text-overflow only where a line count gives it something to cut", () => {
    const clamped = normalizeDesignDocument(textDoc({ "text-overflow": "ellipsis", "line-clamp": 2 }));
    expect(only(clamped.document).style?.textOverflow).toBe("ellipsis");

    // Dropping it is right; dropping it without a word is not — the author is
    // left believing the ellipsis is in.
    const open = normalizeDesignDocument(textDoc({ "text-overflow": "ellipsis" }));
    expect(only(open.document).style?.textOverflow).toBeUndefined();
    expect(drops(open.repairs).map((r) => r.message).join(" ")).toContain("maxLines");

    const clipped = normalizeDesignDocument(textDoc({ textOverflow: "fade" }));
    expect(drops(clipped.repairs).map((r) => r.message).join(" ")).toContain("not one of clip | ellipsis");
  });

  it("reads mix-blend-mode as the element's blendMode", () => {
    const out = normalizeDesignDocument(frameDoc({ "mix-blend-mode": "multiply" }));
    expect(only(out.document).blendMode).toBe("multiply");
    expect(drops(out.repairs)).toEqual([]);
  });

  it("refuses a mix-blend-mode that names no mode rather than blending normally", () => {
    const out = normalizeDesignDocument(frameDoc({ "mix-blend-mode": "luminosity-plus" }));
    expect(only(out.document).blendMode).toBeUndefined();
    expect(out.repairs.some((r) => r.path.endsWith("/blendMode"))).toBe(true);
  });

  it("maps CSS visibility onto the visible flag", () => {
    for (const value of ["hidden", "collapse"]) {
      const out = normalizeDesignDocument(frameDoc({ visibility: value }));
      expect(only(out.document).visible, value).toBe(false);
      expect(drops(out.repairs), value).toEqual([]);
    }
    expect(only(normalizeDesignDocument(frameDoc({ visibility: "visible" })).document).visible).toBe(true);
  });

  it("reports a visibility that names nothing instead of guessing", () => {
    const out = normalizeDesignDocument(frameDoc({ visibility: "nowhere" }));
    expect(only(out.document).visible).toBeUndefined();
    expect(out.repairs.some((r) => r.path.endsWith("/visibility"))).toBe(true);
  });

  it("lets an explicit visible win over a CSS visibility alias", () => {
    const out = normalizeDesignDocument(frameDoc({ visible: true, visibility: "hidden" }));
    expect(only(out.document).visible).toBe(true);
  });

  it("lands objectFit on the image fill's fit, which is the one field it means", () => {
    // `fit` is the dialect's own spelling, in the vocabulary and therefore
    // accepted by the gate; only the CSS pair used to be read.
    for (const key of ["objectFit", "object-fit", "fit"]) {
      const out = normalizeDesignDocument(frameDoc({ [key]: "contain", fills: [imageFill] }));
      expect(only(out.document).fills?.[0]?.fit, key).toBe("contain");
      expect(drops(out.repairs), key).toEqual([]);
    }
  });

  it("defers to a fit the paint itself declares", () => {
    const out = normalizeDesignDocument(frameDoc({ objectFit: "contain", fills: [{ ...imageFill, fit: "cover" }] }));
    expect(only(out.document).fills?.[0]?.fit).toBe("cover");
  });

  it("says so when an objectFit has no image fill to land on", () => {
    const out = normalizeDesignDocument(frameDoc({ objectFit: "contain", fills: [{ type: "solid", color: "#fff" }] }));
    expect(only(out.document).fills?.[0]?.fit).toBeUndefined();
    expect(out.repairs.some((r) => /no image fill to set it on/.test(r.message))).toBe(true);
  });

  it("lands an element-level focalPoint on the image fill, the field it means", () => {
    for (const key of ["focalPoint", "focal-point"]) {
      const out = normalizeDesignDocument(frameDoc({ [key]: { x: 0.25, y: 0.75 }, fills: [imageFill] }));
      expect(only(out.document).fills?.[0]?.focalPoint, key).toEqual({ x: 0.25, y: 0.75 });
      expect(drops(out.repairs), key).toEqual([]);
    }
  });

  it("lands an element-level crop on the image fill, under either spelling", () => {
    for (const key of ["crop", "imageCrop", "image-crop"]) {
      const out = normalizeDesignDocument(frameDoc({ [key]: { x: 4, y: 8, scale: 2 }, fills: [imageFill] }));
      expect(only(out.document).fills?.[0]?.crop, key).toMatchObject({ x: 4, y: 8, scale: 2 });
      expect(drops(out.repairs), key).toEqual([]);
    }
  });

  it("defers to a placement the paint itself declares", () => {
    const out = normalizeDesignDocument(
      frameDoc({
        focalPoint: { x: 0.1, y: 0.1 },
        crop: { x: 1, y: 1, scale: 3 },
        fills: [{ ...imageFill, focalPoint: { x: 0.9, y: 0.9 }, crop: { x: 5, y: 5, scale: 1 } }]
      })
    );
    expect(only(out.document).fills?.[0]?.focalPoint).toEqual({ x: 0.9, y: 0.9 });
    expect(only(out.document).fills?.[0]?.crop).toMatchObject({ x: 5, y: 5, scale: 1 });
  });

  it("says so when an element-level placement has no image fill to land on", () => {
    const out = normalizeDesignDocument(
      frameDoc({ focalPoint: { x: 0.2, y: 0.2 }, crop: { x: 1, y: 1, scale: 2 }, fills: [{ type: "solid", color: "#fff" }] })
    );
    expect(only(out.document).fills?.[0]?.focalPoint).toBeUndefined();
    expect(only(out.document).fills?.[0]?.crop).toBeUndefined();
    expect(out.repairs.filter((r) => /no image fill to set it on/.test(r.message)).length).toBe(2);
  });

  it("reports a malformed element-level focalPoint instead of silence", () => {
    const out = normalizeDesignDocument(frameDoc({ focalPoint: { x: "left" }, fills: [imageFill] }));
    expect(only(out.document).fills?.[0]?.focalPoint).toBeUndefined();
    expect(out.repairs.some((r) => /focalPoint needs numeric x\/y/.test(r.message))).toBe(true);
  });
});

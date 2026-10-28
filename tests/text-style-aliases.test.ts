import { describe, expect, it } from "vitest";
import { FLAT_TEXT_KEYS } from "../src/core/dsl/normalize/css-absorb";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { compactDocumentJson } from "../src/core/document-json";
import { getActivePage } from "../src/core/dsl/types";
import type { TextElement } from "../src/core/dsl/types";

/**
 * The `style` object is the same authored surface as the element level, one
 * level down. It used to accept only the handful of spellings the reader
 * happened to name (`fontSize`, `font_size`, `size` for one field), so
 * `style.textAlign` — CSS's own camel spelling — was neither applied nor
 * reported: the author's centring vanished with `repairs: 0`.
 *
 * The cases below are DERIVED from `FLAT_TEXT_KEYS`. A spelling added to the
 * folding table is graded here without anyone remembering to add a case, and a
 * target with no sample value fails loudly rather than passing by omission.
 */

/** One authored value per STORED field, in the spelling the table names. */
const AUTHORED: Record<string, unknown> = {
  fontSize: 14,
  fontWeight: 700,
  fontFamily: "Georgia",
  fontStyle: "italic",
  lineHeight: 1.5,
  letterSpacing: 2,
  align: "center",
  textTransform: "uppercase",
  textDecoration: "underline",
  verticalAlign: "middle",
  textShadow: "0 1px 2px #000000",
  fontVariantNumeric: "tabular-nums",
  maxLines: 2,
  textOverflow: "ellipsis",
  color: "#112233"
};

/** What the engine must store for the value above. */
const STORED: Record<string, unknown> = {
  ...AUTHORED,
  // A decoration is a line SET in the document, not the CSS shorthand.
  textDecoration: ["underline"]
};

const TARGETS = [...new Set(Object.values(FLAT_TEXT_KEYS))];

const normalized = (elements: unknown[]) =>
  normalizeDesignDocument({ version: "0.1", canvas: { width: 400, height: 200, unit: "px" }, elements });

const textOf = (elements: unknown[]) =>
  getActivePage(normalized(elements).document).children[0] as TextElement;

const styleOf = (style: Record<string, unknown>) =>
  textOf([{ id: "t", type: "text", content: "Home", width: 72, height: 24, style }]).style;

describe("every CSS spelling inside `style` reaches the field the renderer reads", () => {
  it("has a sample value for every target the folding table names", () => {
    // Not a formality: a target with no sample is a spelling this rig cannot
    // grade, and silently skipping it is how the original gap survived.
    expect(TARGETS.filter((target) => AUTHORED[target] === undefined)).toEqual([]);
  });

  for (const [spelling, target] of Object.entries(FLAT_TEXT_KEYS)) {
    it(`style.${spelling} is stored as style.${target}`, () => {
      const authored: Record<string, unknown> = { [spelling]: AUTHORED[target] };
      // `text-overflow` is kept only beside a line count — it has nothing to cut
      // otherwise, so it is authored with the clamp it belongs to.
      if (target === "textOverflow") authored.maxLines = AUTHORED.maxLines;
      // A shadow has ONE home and it is `effects[]`: the CSS string is an input
      // alias that normalize folds and drops (see `takeTextShadow`), so the
      // stored field is the effect stack, not `style.textShadow`.
      if (target === "textShadow") {
        const el = textOf([{ id: "t", type: "text", content: "Home", width: 72, height: 24, style: authored }]);
        expect(el.style.textShadow).toBeUndefined();
        expect(el.effects?.[0]?.type).toBe("drop-shadow");
        return;
      }
      const style = styleOf(authored);
      expect(style[target as keyof typeof style]).toEqual(STORED[target]);
    });
  }
});

describe("the reported case: a 72px tab label that would not centre", () => {
  const authored = {
    id: "home_tab0_label",
    type: "text",
    x: 0,
    y: 0,
    width: 72,
    height: 24,
    content: "Home",
    style: { fontSize: 14, color: "#111111", textAlign: "center" }
  };

  it("applies the alignment instead of dropping it in silence", () => {
    const result = normalized([authored]);
    expect((getActivePage(result.document).children[0] as TextElement).style.align).toBe("center");
    expect(result.repairs).toEqual([]);
  });

  it("writes it back out as the CSS spelling the file stores", () => {
    const json = JSON.parse(compactDocumentJson(normalized([authored]).document));
    expect(json.pages[0].children[0]["text-align"]).toBe("center");
  });
});

describe("a style key nothing reads is reported, never swallowed", () => {
  it("names an unknown key with the element path", () => {
    const result = normalized([
      { id: "t", type: "text", content: "x", style: { fontSize: 14, aling: "center" } }
    ]);
    expect(result.repairs).toEqual([
      expect.objectContaining({
        kind: "dropped-property",
        path: "/elements/0/style/aling",
        message: expect.stringContaining('"aling"')
      })
    ]);
    // No `severity: "info"`: an authored property that did nothing is a failure,
    // not a note — `check` must exit non-zero on it.
    expect(result.repairs[0].severity).toBeUndefined();
  });

  it("prefers the canonical key and reports the alias it overrode", () => {
    const result = normalized([
      {
        id: "t",
        type: "text",
        content: "x",
        style: { fontSize: 14, align: "left", textAlign: "center" }
      }
    ]);
    expect((getActivePage(result.document).children[0] as TextElement).style.align).toBe("left");
    expect(result.repairs).toEqual([
      expect.objectContaining({ path: "/elements/0/style/textAlign" })
    ]);
  });

  it("stays silent when both spellings agree — nothing was discarded", () => {
    const result = normalized([
      { id: "t", type: "text", content: "x", style: { fontSize: 14, align: "center", "text-align": "center" } }
    ]);
    expect(result.repairs).toEqual([]);
  });
});

describe("element level and style level are one statement, whatever the spelling", () => {
  it("the inner level wins, spelled either way", () => {
    // `style.align` beat the outer key from the start; `style.textAlign` used to
    // lose to it because the fold only looked for the canonical key.
    for (const inner of ["align", "textAlign", "text-align"]) {
      const result = normalized([
        { id: "t", type: "text", content: "x", "text-align": "left", style: { fontSize: 14, [inner]: "center" } }
      ]);
      expect((getActivePage(result.document).children[0] as TextElement).style.align).toBe("center");
      expect(result.repairs).toEqual([expect.objectContaining({ path: "/elements/0/text-align" })]);
    }
  });

  it("and a style that says nothing lets the outer key through", () => {
    const result = normalized([
      { id: "t", type: "text", content: "x", "text-align": "center", style: { fontSize: 14 } }
    ]);
    expect((getActivePage(result.document).children[0] as TextElement).style.align).toBe("center");
    expect(result.repairs).toEqual([]);
  });
});

describe("a document-level text style takes the same road", () => {
  it("folds the spelling, then refuses what a style cannot own", () => {
    // `textAlign` reaches `align` on the way in — the fold is the same one the
    // element level takes. What differs is the destination: `align` places the
    // LAYER's box, so a text style may not keep it (`TEXT_STYLE_KEYS`).
    const result = normalizeDesignDocument({
      version: "0.1",
      canvas: { width: 400, height: 200, unit: "px" },
      elements: [],
      styles: [
        { id: "s1", name: "Tab label", styleType: "text", style: { fontSize: 14, color: "#111111", textAlign: "center" } }
      ]
    });
    const style = (result.document.styles?.[0] as any).style;
    expect(style.align).toBeUndefined();
    expect(style.color).toBeUndefined();
    expect(style.fontSize).toBe(14);
    expect(result.repairs.map((r) => r.path).sort()).toEqual([
      "/styles[0]/style/align",
      "/styles[0]/style/color"
    ]);
  });
});

describe("the gate accepts what the reader still reads", () => {
  it("passes token bindings through in both dialect spellings", () => {
    for (const spelling of ["tokenBindings", "token-bindings"]) {
      const result = normalized([
        { id: "t", type: "text", content: "x", style: { fontSize: 14, [spelling]: { color: "tok" } } }
      ]);
      expect((getActivePage(result.document).children[0] as TextElement).style.tokenBindings).toEqual({ color: "tok" });
      expect(result.repairs).toEqual([]);
    }
  });
});

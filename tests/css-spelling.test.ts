import { describe, it, expect } from "vitest";
import { CANONICAL_KEYS } from "../src/core/dsl/normalize/element";
import { CSS_KEY_MAP, NO_CSS_EQUIVALENT, applyCssSpelling } from "../src/core/dsl/css-spelling";
import { documentJson } from "../src/core/document-json";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";

/**
 * The file speaks CSS. These are the gates that keep it that way, and they
 * derive from the vocabulary rather than restating it: add a field to
 * `CANONICAL_KEYS` and this test tells you to classify it, instead of letting it
 * reach disk as camelCase that no CSS-writing author would ever guess.
 */

const camel = (key: string): boolean => /[a-z][A-Z]/.test(key);

const canvas = { width: 400, height: 300, background: { type: "solid" as const, color: "#FFFFFF" } };

const fixture = {
  version: LATEST_DOCUMENT_VERSION,
  name: "Spelling",
  canvas,
  elements: [
    {
      id: "f",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      clipContent: true,
      borderRadius: 8,
      blendMode: "multiply",
      visible: false,
      children: [
        { id: "p", type: "path", d: "M0 0L8 8Z", fillRule: "evenodd" },
        { id: "t", type: "text", content: "hi", width: 40, height: 20 }
      ]
    }
  ]
};

const exported = (): Record<string, any> =>
  JSON.parse(documentJson(normalizeDesignDocument(fixture).document)) as Record<string, any>;

describe("the exported dialect is CSS", () => {
  it("writes the CSS spelling for every key that has one", () => {
    const el = exported().pages[0].children[0];
    expect(el["border-radius"]).toBe("8px");
    expect(el.overflow).toBe("hidden");
    expect(el["mix-blend-mode"]).toBe("multiply");
    expect(el.visibility).toBe("hidden");
    expect(el.children[0]["fill-rule"]).toBe("evenodd");
    for (const gone of ["borderRadius", "clipContent", "blendMode", "visible", "fillRule"]) {
      expect(el, gone).not.toHaveProperty(gone);
    }
  });

  it("writes CSS value shapes, not the engine's numbers", () => {
    const doc = normalizeDesignDocument({
      ...fixture,
      elements: [
        {
          id: "r",
          type: "rect",
          width: 80,
          height: 40,
          rotation: 45,
          flipX: true,
          borderRadius: [8, 8, 0, 0],
          rotateX: 20,
          children: []
        },
        {
          id: "t",
          type: "text",
          content: "hi",
          width: 100,
          height: 20,
          style: {
            fontFamily: "Inter",
            fontSize: 16,
            lineHeight: 1.4,
            color: "#112233",
            align: "center",
            maxLines: 2,
            textDecoration: ["underline", "line-through"]
          }
        }
      ]
    }).document;
    const [rect, text] = (JSON.parse(documentJson(doc)) as any).pages[0].children;

    expect(rect.rotate).toBe("45deg");
    expect(rect.scale).toBe("-1 1");
    expect(rect.transform).toBe("rotateX(20deg)");
    expect(rect["border-radius"]).toBe("8px 8px 0 0");
    expect(rect).not.toHaveProperty("rotation");

    expect(text["font-size"]).toBe("16px");
    expect(text["line-height"]).toBe(1.4);
    expect(text["text-align"]).toBe("center");
    expect(text.color).toBe("#112233");
    expect(text["line-clamp"]).toBe(2);
    expect(text["text-decoration"]).toBe("underline line-through");
    expect(text).not.toHaveProperty("style");

    // The value shapes are only worth writing if they come back identical.
    const back = normalizeDesignDocument(JSON.parse(documentJson(doc))).document;
    expect(back.pages[0].children).toEqual(doc.pages[0].children);
  });

  it("compresses a symmetric border radius the way CSS does", () => {
    const doc = normalizeDesignDocument({
      ...fixture,
      elements: [
        { id: "pill", type: "rect", width: 80, height: 40, borderRadius: [8, 16, 8, 16] },
        { id: "round", type: "rect", width: 40, height: 40, borderRadius: [12, 12, 12, 12] }
      ]
    }).document;
    const [pill, round] = (JSON.parse(documentJson(doc)) as any).pages[0].children;
    expect(pill["border-radius"]).toBe("8px 16px");
    expect(round["border-radius"]).toBe("12px");

    const back = normalizeDesignDocument(JSON.parse(documentJson(doc))).document;
    expect(back.pages[0].children).toEqual(doc.pages[0].children);
  });

  it("writes maskMode as CSS mask-mode", () => {
    const doc = normalizeDesignDocument({
      ...fixture,
      elements: [
        {
          id: "m",
          type: "rect",
          width: 100,
          height: 100,
          isMask: true,
          maskMode: "luminance"
        }
      ]
    }).document;
    const [mask] = (JSON.parse(documentJson(doc)) as any).pages[0].children;

    expect(mask["mask-mode"]).toBe("luminance");
    expect(mask).not.toHaveProperty("maskMode");

    const back = normalizeDesignDocument(JSON.parse(documentJson(doc))).document;
    expect(back.pages[0].children).toEqual(doc.pages[0].children);
  });

  it("writes CSS lengths and the spacing shorthand", () => {
    const doc = normalizeDesignDocument({
      ...fixture,
      elements: [
        {
          id: "f",
          type: "frame",
          x: 0,
          y: 12.5,
          width: 320,
          height: 240,
          display: "flex",
          gap: 12,
          padding: [8, 16, 8, 16],
          perspective: 900,
          children: [
            {
              id: "c",
              type: "rect",
              x: 0,
              y: 0,
              width: 80,
              height: 40,
              margin: [4, 8, 4, 8],
              sizing: { width: "fill", minWidth: 120, maxWidth: 300 }
            }
          ]
        }
      ]
    }).document;
    const [frame] = (JSON.parse(documentJson(doc)) as any).pages[0].children;
    const child = frame.children[0];

    expect(frame.x).toBe("0");
    expect(frame.y).toBe("12.5px");
    expect(frame.width).toBe("320px");
    expect(frame.height).toBe("240px");
    expect(frame.perspective).toBe("900px");
    expect(frame.gap).toBe("12px");
    expect(frame.padding).toBe("8px 16px");
    expect(child.margin).toBe("4px 8px");
    expect(child["min-width"]).toBe("120px");
    expect(child["max-width"]).toBe("300px");
    expect(child.sizing).not.toHaveProperty("minWidth");
    expect(child.sizing).not.toHaveProperty("maxWidth");

    const back = normalizeDesignDocument(JSON.parse(documentJson(doc))).document;
    expect(back.pages[0].children).toEqual(doc.pages[0].children);
  });

  it("writes explicit grid tracks as a CSS track list", () => {
    const doc = normalizeDesignDocument({
      ...fixture,
      elements: [
        {
          id: "g",
          type: "frame",
          width: 600,
          height: 400,
          display: "grid",
          "grid-template-columns": [280, { fr: 1 }, "2fr"],
          "grid-template-rows": [100, { fr: 2 }]
        },
        {
          id: "count",
          type: "frame",
          width: 300,
          height: 200,
          display: "grid",
          "grid-template-columns": 3
        }
      ]
    }).document;
    const [grid, count] = (JSON.parse(documentJson(doc)) as any).pages[0].children;

    expect(grid["grid-template-columns"]).toBe("280px 1fr 2fr");
    expect(grid["grid-template-rows"]).toBe("100px 2fr");
    expect(count["grid-template-columns"]).toBe(3);

    const back = normalizeDesignDocument(JSON.parse(documentJson(doc))).document;
    expect(back.pages[0].children).toEqual(doc.pages[0].children);
  });

  it("writes a grid placement as CSS line ranges", () => {
    const doc = normalizeDesignDocument({
      ...fixture,
      elements: [
        {
          id: "g",
          type: "frame",
          width: 600,
          height: 400,
          display: "grid",
          "grid-template-columns": 3,
          children: [
            {
              id: "wide",
              type: "rect",
              width: 100,
              height: 100,
              "grid-area": { column: 2, row: 1, columnSpan: 2, rowSpan: 2 }
            },
            {
              id: "span",
              type: "rect",
              width: 100,
              height: 100,
              "grid-area": { columnSpan: 2 }
            },
            {
              id: "line",
              type: "rect",
              width: 100,
              height: 100,
              "grid-area": { column: 3 }
            }
          ]
        }
      ]
    }).document;
    const [grid] = (JSON.parse(documentJson(doc)) as any).pages[0].children;
    const [wide, span, line] = grid.children;

    expect(wide["grid-column"]).toBe("2 / span 2");
    expect(wide["grid-row"]).toBe("1 / span 2");
    expect(span["grid-column"]).toBe("span 2");
    expect(span).not.toHaveProperty("grid-row");
    expect(line["grid-column"]).toBe("3");
    for (const child of grid.children) expect(child).not.toHaveProperty("grid-area");

    const back = normalizeDesignDocument(JSON.parse(documentJson(doc))).document;
    expect(back.pages[0].children).toEqual(doc.pages[0].children);
  });

  it("keeps every other element key free of camelCase", () => {
    const walk = (el: Record<string, unknown>): void => {
      for (const key of Object.keys(el)) {
        // Only element-level keys: `sizing` and `sizing.minWidth` are the
        // engine's own shape and are not authored at this level.
        if (camel(key)) {
          expect(NO_CSS_EQUIVALENT, `"${key}" reached disk as camelCase`).toHaveProperty(key);
        }
      }
      for (const child of (el.children as Record<string, unknown>[]) ?? []) walk(child);
    };
    for (const el of exported().pages[0].children) walk(el);
  });

  it("classifies every camelCase key the vocabulary knows, in both directions", () => {
    for (const key of CANONICAL_KEYS) {
      if (!camel(key)) continue;
      expect(
        CSS_KEY_MAP[key] !== undefined || NO_CSS_EQUIVALENT[key] !== undefined,
        `"${key}" is neither mapped to a CSS property nor exempted`
      ).toBe(true);
    }
    // A stale exemption is a claim about a key nothing reads any more.
    for (const key of Object.keys(NO_CSS_EQUIVALENT)) {
      expect(CANONICAL_KEYS.has(key), `"${key}" is exempted but not in the vocabulary`).toBe(true);
    }
  });

  it("does not rename a key it does not also read back", () => {
    // Every mapped key must survive a round trip through the normalizer, which is
    // what makes the rename a spelling change rather than a data change.
    const doc = normalizeDesignDocument(fixture).document;
    const spelled = applyCssSpelling(doc as unknown as Record<string, unknown>);
    const back = normalizeDesignDocument(spelled).document;
    expect(back.pages[0].children).toEqual(doc.pages[0].children);
  });
});

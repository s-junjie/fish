import { beforeEach, describe, expect, it } from "vitest";
import type { DesignDocument, DesignElement, TextElement } from "../src/core/dsl/types";
import { resetFontStatus, setFontWidthProbe } from "../src/core/fonts/font-status";
import { setTextMeasurer } from "../src/core/geometry/text-measure";
import { replaceFontFamily } from "../src/core/interactions/font-replace";

/**
 * The same two seams the freeze is graded with: a machine whose font list the
 * test decides, and a measurer whose advances for the real face differ from the
 * substitute's — so "the box was re-measured" is a number, not an impression.
 */
const BASELINE: Record<string, number> = { monospace: 100, serif: 90, "sans-serif": 70, "system-ui": 70 };

const probe = (cssFont: string): number => {
  const stack = cssFont.replace(/^\S+\s+\S+\s+/, "");
  for (const raw of stack.split(",")) {
    const name = raw.trim().replace(/^"|"$/g, "");
    if (BASELINE[name] !== undefined) return BASELINE[name];
  }
  return BASELINE["sans-serif"];
};

const measurer = (_content: string, spec: { fontFamily?: string; fontSize: number }) => {
  const real = spec.fontFamily === "Gone Sans";
  const width = (_content.length || 1) * (real ? 10 : 6);
  return { width, height: Math.round(width / 4), lines: 1 };
};

const text = (id: string, style: Record<string, unknown>, extra: Record<string, unknown> = {}): TextElement =>
  ({
    id,
    name: id,
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 50,
    content: "Hello world",
    sizing: { width: "fit-content", height: "fit-content" },
    style: { fontSize: 16, ...style },
    ...extra
  }) as unknown as TextElement;

const doc = (children: DesignElement[], extra: Record<string, unknown> = {}): DesignDocument =>
  ({
    version: "0.1",
    name: "fonts",
    canvas: { width: 800, height: 600 },
    pages: [{ id: "p1", name: "Page 1", children }],
    ...extra
  }) as unknown as DesignDocument;

const kids = (d: DesignDocument): DesignElement[] => d.pages![0].children;

beforeEach(() => {
  resetFontStatus();
  setFontWidthProbe(probe);
  setTextMeasurer(measurer);
});

describe("replaceFontFamily", () => {
  it("rewrites the layer, its runs and the shared style in the document scope", () => {
    const before = doc(
      [
        text("a", { fontFamily: "Gone Sans" }, {
          textStyleId: "s1",
          spans: [
            { text: "Hello ", style: { fontFamily: "Gone Sans" } },
            { text: "world", style: { fontWeight: 700 } }
          ]
        })
      ],
      {
        styles: [{ id: "s1", name: "Display", styleType: "text", style: { fontFamily: "Gone Sans", fontSize: 32 } }],
        fonts: [{ family: "Gone Sans", src: "data:font/woff2;base64,AA" }]
      }
    );

    const after = replaceFontFamily(before, "Gone Sans", "system-ui", "document");
    const el = kids(after)[0] as TextElement;

    expect(el.style.fontFamily).toBe("system-ui");
    expect(el.spans?.[0].style?.fontFamily).toBe("system-ui");
    // A run that never named a family keeps not naming one.
    expect(el.spans?.[1].style?.fontFamily).toBeUndefined();
    expect((after.styles![0] as any).style.fontFamily).toBe("system-ui");
    // The binding survives: the document scope changed the style itself.
    expect(el.textStyleId).toBe("s1");
    // A carried face for a family the file no longer uses is dead weight.
    expect(after.fonts).toBeUndefined();
  });

  it("touches only the selected layers in the selection scope", () => {
    const before = doc(
      [
        text("a", { fontFamily: "Gone Sans" }),
        text("b", { fontFamily: "Gone Sans" }),
        text("c", { fontFamily: "system-ui" })
      ],
      {
        styles: [{ id: "s1", name: "Display", styleType: "text", style: { fontFamily: "Gone Sans", fontSize: 32 } }]
      }
    );

    const after = replaceFontFamily(before, "Gone Sans", "system-ui", {
      elementIds: new Set(["a"])
    });

    expect((kids(after)[0] as TextElement).style.fontFamily).toBe("system-ui");
    expect((kids(after)[1] as TextElement).style.fontFamily).toBe("Gone Sans");
    expect((kids(after)[2] as TextElement).style.fontFamily).toBe("system-ui");
    // A shared style is not the selection's to rewrite.
    expect((after.styles![0] as any).style.fontFamily).toBe("Gone Sans");
  });

  it("detaches a style-bound layer in the selection scope, or the write would not stick", () => {
    // `syncDualStorage` re-materialises a bound layer's whole `style` from its
    // style, so a family written onto the layer alone is gone by the next
    // commit. Replacing on ONE layer therefore has to end the binding.
    const before = doc([text("a", { fontFamily: "Gone Sans" }, { textStyleId: "s1" })], {
      styles: [{ id: "s1", name: "Display", styleType: "text", style: { fontFamily: "Gone Sans", fontSize: 32 } }]
    });

    const after = replaceFontFamily(before, "Gone Sans", "system-ui", { elementIds: new Set(["a"]) });
    expect((kids(after)[0] as TextElement).textStyleId).toBeUndefined();
  });

  it("leaves a stack that declared its own fallback alone", () => {
    // `"Gone Sans, sans-serif"` is the author saying what a substitution should
    // look like — it is never reported missing, so replacing it would edit
    // layers nobody asked about.
    const before = doc([text("a", { fontFamily: "Gone Sans, sans-serif" })]);
    const after = replaceFontFamily(before, "Gone Sans", "system-ui", "document");
    expect(after).toBe(before);
  });

  it("returns the same document when it matched nothing", () => {
    // A no-op has to keep its identity, or the caller pushes an undo step that
    // undoes nothing.
    const before = doc([text("a", { fontFamily: "system-ui" })]);
    expect(replaceFontFamily(before, "Gone Sans", "Arial", "document")).toBe(before);
    expect(replaceFontFamily(before, "system-ui", "   ", "document")).toBe(before);
  });

  it("re-measures the frozen box with the replacement's metrics", () => {
    // The whole point of the replacement: the box was frozen at 200 × 50 while
    // the family was missing (the real face measures 110 × 28), and the moment
    // an installed family is in place the layout is allowed to run again.
    const before = doc([text("a", { fontFamily: "Gone Sans" })]);
    expect((kids(before)[0] as TextElement).width).toBe(200);

    const after = replaceFontFamily(before, "Gone Sans", "system-ui", "document");
    const el = kids(after)[0] as TextElement;
    expect(el.width).toBe(66);
    expect(el.height).toBe(17);
  });

  it("does not re-measure into a family that is missing too", () => {
    const before = doc([text("a", { fontFamily: "Gone Sans" })]);
    const after = replaceFontFamily(before, "Gone Sans", "Also Gone", "document");
    expect(after).not.toBe(before);
    // Still frozen: the replacement cannot be painted either, so the stored box
    // is still the best description of the text.
    expect((kids(after)[0] as TextElement).width).toBe(200);
  });

  it("reaches text nested in a frame", () => {
    const frame = {
      id: "f1",
      name: "f1",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      children: [text("a", { fontFamily: "Gone Sans" })]
    } as unknown as DesignElement;
    const before = doc([frame], {
      styles: [{ id: "s1", name: "Display", styleType: "text", style: { fontFamily: "Gone Sans", fontSize: 32 } }]
    });

    const after = replaceFontFamily(before, "Gone Sans", "system-ui", "document");
    const nested = (kids(after)[0] as any).children[0] as TextElement;
    expect(nested.style.fontFamily).toBe("system-ui");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { DesignElement, TextElement } from "../src/core/dsl/types";
import { resetFontStatus, setFontWidthProbe } from "../src/core/fonts/font-status";
import { setTextMeasurer } from "../src/core/geometry/text-measure";
import { resolveTextSizing, syncTextSizing, textSizingIsFrozen } from "../src/core/layout/text-sizing";

/**
 * The machine's font list, and a measurer that gives a substitute DIFFERENT
 * advances from the real face — which is the whole reason the box is frozen.
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

/** 10 units per character at the real face, 6 at the substitute. */
const measurer = (_content: string, spec: { fontFamily?: string; fontSize: number }) => {
  const real = spec.fontFamily === "Gone Sans";
  const width = (_content.length || 1) * (real ? 10 : 6);
  return { width, height: Math.round(width / 4), lines: 1 };
};

const text = (style: Record<string, unknown>, box?: { width: number; height: number }): TextElement =>
  ({
    id: "t1",
    name: "t1",
    type: "text",
    x: 0,
    y: 0,
    width: box?.width ?? 200,
    height: box?.height ?? 50,
    content: "Hello world",
    sizing: { width: "fit-content", height: "fit-content" },
    style: { fontSize: 16, ...style }
  }) as unknown as TextElement;

beforeEach(() => {
  resetFontStatus();
  setFontWidthProbe(probe);
  setTextMeasurer(measurer);
});

describe("a box sized in a font this machine does not have", () => {
  it("is left exactly as the author saved it", () => {
    const el = text({ fontFamily: "Gone Sans" });
    expect(resolveTextSizing(el, null)).toBe(el);
  });

  it("re-measures as soon as the family is available", () => {
    // Same document, same box, a machine that HAS the face: the stored 200 × 50
    // is what the real metrics produce, so it survives — but the measurement is
    // now allowed to run, which is what lets a replaced family resize it.
    const el = text({ fontFamily: "system-ui" });
    const resolved = resolveTextSizing(el, null);
    expect(resolved).not.toBe(el);
    expect(resolved.width).toBe(66);
    expect(resolved.height).toBe(17);
  });

  it("freezes on a span's family too, not only the layer's", () => {
    // The layer is set in a font this machine has; one run inside it is not, and
    // that run's advances are just as wrong as the whole paragraph's.
    const el = {
      ...text({ fontFamily: "system-ui" }),
      spans: [{ text: "Hello", style: { fontFamily: "Gone Sans" } }]
    } as TextElement;
    expect(resolveTextSizing(el, null)).toBe(el);
  });

  it("does not freeze a box that was never sized", () => {
    // Zero means "never measured", not "authored": freezing it would leave a new
    // text layer at 0 × 0 with no way to grow.
    const el = text({ fontFamily: "Gone Sans" }, { width: 0, height: 0 });
    expect(resolveTextSizing(el, null).width).toBe(66);
  });

  it("does not call a box frozen when the author pinned both axes", () => {
    // Nothing would re-measure it, so the freeze protects nothing — and the edit
    // gate that shares this predicate has no reason to take the caret away.
    const el = {
      ...text({ fontFamily: "Gone Sans" }),
      sizing: { width: "fixed", height: "fixed" }
    } as TextElement;
    expect(textSizingIsFrozen(el)).toBe(false);
    expect(resolveTextSizing(el, null)).toBe(el);
  });

  it("freezes inside a tree, so `syncTextSizing` cannot reach it through a frame", () => {
    const frame = {
      id: "f1",
      name: "f1",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      children: [text({ fontFamily: "Gone Sans" }), text({ fontFamily: "system-ui" })]
    } as unknown as DesignElement;
    const [out] = syncTextSizing([frame]) as any[];
    const [frozen, thawed] = out.children;
    expect(frozen.width).toBe(200);
    expect(thawed.width).toBe(66);
  });
});

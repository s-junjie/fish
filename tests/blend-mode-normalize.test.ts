import { describe, it, expect } from "vitest";
import schema from "../src/core/dsl/fish.schema.json";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import type { NormalizationRepair } from "../src/core/dsl/normalize/shared";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * A blend mode the DSL publishes must survive a load, and one it does not must
 * be reported.
 *
 * The vocabulary lived in four places and two of them disagreed with the schema:
 * the normalizer's table knew four of the sixteen modes, so a document written
 * with `blendMode: "difference"` came back blending normally, and the inspector
 * offered twelve — pick "Difference" and the canvas is right until the next
 * load. Neither said anything in `repairs`, the one channel an author has for
 * learning that a value was refused.
 */

const MODES = schema.definitions.BlendMode.enum as string[];

const doc = (elements: unknown[]): DesignDocument =>
  ({
    docId: "d",
    version: "0.1",
    name: "n",
    canvas: { width: 1440, height: 900, background: { type: "solid", color: "#FFFFFF" } },
    pages: [{ id: "p1", name: "P1", children: elements }]
  }) as unknown as DesignDocument;

const rect = (over: Record<string, unknown> = {}) => ({
  id: "a",
  type: "rect",
  name: "r",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fills: [{ type: "solid", color: "#FF0000" }],
  ...over
});

const normalize = (elements: unknown[]) => normalizeDesignDocument(doc(elements));
const only = (d: DesignDocument) => d.pages[0].children[0] as DesignElement;
/** `kind path` pairs, so a repair cannot pass by matching the message alone. */
const where = (out: { repairs: NormalizationRepair[] }) =>
  out.repairs.map((r) => `${r.kind} ${r.path}`);

describe("blend mode normalization", () => {
  // The per-mode cases below are generated FROM the schema, so this only has to
  // hold the generator honest — an empty or shrunken enum would make them all
  // vacuously true, which is how a four-mode table passed for so long.
  it("tests a vocabulary worth testing", () => {
    expect(MODES.length).toBeGreaterThan(4);
  });

  it.each(MODES)("keeps %s on an element", (mode) => {
    const out = normalize([rect({ blendMode: mode })]);
    expect((only(out.document) as { blendMode?: string }).blendMode).toBe(mode);
    expect(out.repairs).toEqual([]);
  });

  it.each(MODES)("keeps %s on a fill layer", (mode) => {
    const out = normalize([rect({ fills: [{ type: "solid", color: "#FF0000", blendMode: mode }] })]);
    const fills = (only(out.document) as { fills?: { blendMode?: string }[] }).fills;
    expect(fills?.[0]?.blendMode).toBe(mode);
    expect(out.repairs).toEqual([]);
  });

  it("accepts the CSS and Figma spellings of the same modes", () => {
    const spellings: [string, string][] = [
      ["source-over", "normal"],
      ["Pass Through", "normal"],
      ["MultiplyBlend", "multiply"],
      // Linear burn has no CSS counterpart (`plus-darker` left the spec), so
      // `color-burn` is the nearest name and the DSL names it.
      ["LINEAR_BURN", "color-burn"],
      // Linear dodge IS additive, and CSS spells that `plus-lighter`. It read as
      // `color-dodge` — a division — which resolves to black against a
      // transparent backdrop and turned a translucent sheen layer into a dark
      // one.
      ["linear-dodge", "plus-lighter"],
      ["Soft Light", "soft-light"],
      ["luminosity", "luminosity"],
      ["plus-lighter", "plus-lighter"]
    ];
    for (const [written, mode] of spellings) {
      const out = normalize([rect({ blendMode: written })]);
      expect((only(out.document) as { blendMode?: string }).blendMode, written).toBe(mode);
      expect(out.repairs, written).toEqual([]);
    }
  });

  it("accepts the `blend` alias at both levels, as dsl.md §11 promises", () => {
    const element = normalize([rect({ blend: "difference" })]);
    expect((only(element.document) as { blendMode?: string }).blendMode).toBe("difference");
    expect(element.repairs).toEqual([]);

    const layer = normalize([rect({ fills: [{ type: "solid", color: "#FF0000", blend: "screen" }] })]);
    expect((only(layer.document) as { fills?: { blendMode?: string }[] }).fills?.[0]?.blendMode).toBe("screen");
    expect(layer.repairs).toEqual([]);
  });

  it("drops a mode it does not know, and names it", () => {
    const out = normalize([rect({ blendMode: "glow" })]);
    expect((only(out.document) as { blendMode?: string }).blendMode).toBeUndefined();
    expect(where(out)).toEqual(["element /pages/0/children/0/blendMode"]);
    expect(out.repairs[0].message).toContain('"glow"');
  });

  it("reports the refusal on a fill layer and on a stroke's own paint", () => {
    const fills = normalize([rect({ fills: [{ type: "solid", color: "#FF0000", blendMode: "glow" }] })]);
    expect(where(fills)).toEqual(["paint /pages/0/children/0/fills/0/blendMode"]);

    const stroke = normalize([
      rect({ strokes: [{ color: "#000000", width: 1, paint: { type: "solid", color: "#FF0000", blendMode: "glow" } }] })
    ]);
    expect(where(stroke)).toEqual(["paint /pages/0/children/0/strokes/0/paint/blendMode"]);
  });

  it("treats a value that is not a mode as a refusal, not as silence", () => {
    const out = normalize([rect({ blendMode: 42 })]);
    expect((only(out.document) as { blendMode?: string }).blendMode).toBeUndefined();
    expect(where(out)).toEqual(["element /pages/0/children/0/blendMode"]);
    expect(out.repairs[0].message).toContain('"42"');
  });

  it("says nothing when no mode was written", () => {
    const out = normalize([rect()]);
    expect((only(out.document) as { blendMode?: string }).blendMode).toBeUndefined();
    expect(out.repairs).toEqual([]);
  });

  it("reaches a fixed point after a refusal", () => {
    const first = normalize([rect({ blendMode: "glow" })]);
    const second = normalizeDesignDocument(first.document);
    expect(where(second)).toEqual([]);
  });
});

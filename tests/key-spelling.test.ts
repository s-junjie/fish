import { describe, expect, it } from "vitest";
import { normalizeDesignDocument, CANONICAL_KEYS } from "../src/core/dsl/normalize";
import type { DesignDocument, DesignElement, TextElement } from "../src/core/dsl/types";

/**
 * The dialect has exactly two spellings for a key: camelCase for its own fields
 * (`isMask`) and kebab-case for anything CSS names (`mix-blend-mode`). Both are
 * listed in `CANONICAL_KEYS`.
 *
 * `snake_case` is neither. `canonicalKey` folds `_` onto `-`, so `is_mask` used
 * to collapse onto `isMask` and be ACCEPTED by the unknown-key gate — while no
 * reader ever looked at it. A key that reports nothing and does nothing is the
 * exact failure the gate exists to prevent, so the spelling is refused by name.
 */

const canvas = { width: 800, height: 600, background: { type: "solid", color: "#FFFFFF" } };

const load = (over: Record<string, unknown>, type = "rect") => {
  const doc = {
    version: "0.1",
    canvas,
    pages: [{ id: "p1", name: "P1", canvas, children: [{ id: "e", type, width: 10, height: 10, ...over }] }],
    activePageId: "p1"
  } as unknown as DesignDocument;
  return normalizeDesignDocument(doc);
};

const el = (over: Record<string, unknown>, type = "rect"): DesignElement => load(over, type).document.pages[0].children[0];
const textEl = (over: Record<string, unknown>): TextElement => el(over, "text") as TextElement;
const dropped = (over: Record<string, unknown>, key: string, type = "rect"): boolean =>
  load(over, type).repairs.some((r) => r.kind === "dropped-property" && r.message.includes(`"${key}"`));

describe("a snake_case key is refused by name", () => {
  it("reports is_mask instead of silently accepting it", () => {
    expect(dropped({ is_mask: true }, "is_mask")).toBe(true);
    expect(el({ is_mask: true }).isMask).toBeUndefined();
  });

  it("reports the style-id spellings", () => {
    for (const key of ["fill_style_id", "stroke_style_id", "effect_style_id", "text_style_id"]) {
      expect(dropped({ [key]: "s1" }, key), key).toBe(true);
    }
  });

  // The fold into `style` used to run before the gate and delete the key, so a
  // snake text property was applied where every other snake key was refused.
  it("reports a snake_case text property instead of folding it into style", () => {
    expect(dropped({ font_size: 37 }, "font_size", "text")).toBe(true);
    expect(textEl({ font_size: 37 }).style?.fontSize).not.toBe(37);
    expect(dropped({ border_radius: 8 }, "border_radius")).toBe(true);
  });

  it("refuses snake_case inside style too", () => {
    const result = load({ style: { font_size: 37 } }, "text");
    expect((result.document.pages[0].children[0] as TextElement).style?.fontSize).not.toBe(37);
    expect(result.repairs.some((r) => r.message.includes('"font_size"'))).toBe(true);
  });

  it("reports a bound written snake_case", () => {
    expect(dropped({ min_width: 40 }, "min_width")).toBe(true);
  });

  // `align-self` is real and read, and the reader had grown a third spelling for
  // it — `align_self`, the one shape every other snake key is refused in. A key
  // the gate reports as dropped while the reader applies it is the false repair
  // that costs the same as a silent drop.
  it("reports align_self instead of quietly applying it", () => {
    expect(dropped({ align_self: "center" }, "align_self")).toBe(true);
    expect(
      (el({ align_self: "center" }) as unknown as Record<string, unknown>)["align-self"]
    ).toBeUndefined();
  });
});

describe("the two spellings the dialect does have still work", () => {
  it("reads camelCase", () => {
    expect(el({ isMask: true }).isMask).toBe(true);
    expect(el({ blendMode: "multiply" }).blendMode).toBe("multiply");
  });

  it("reads kebab-case", () => {
    expect(el({ "mix-blend-mode": "multiply" }).blendMode).toBe("multiply");
    // `borderRadius` is not on every member of the union, so the narrowing is
    // part of the assertion: a rect that lost the key would read `undefined`.
    const rounded = el({ "border-radius": 8 });
    expect("borderRadius" in rounded && rounded.borderRadius).toBe(8);
  });

  it("reads a camel spelling of a stored CSS key, without a repair", () => {
    const { repairs } = load({ display: "flex", flexDirection: "column" });
    expect(repairs.some((r) => r.message.includes("flexDirection"))).toBe(false);
  });
});

/**
 * The two spellings of a key must behave identically, graded against
 * `CANONICAL_KEYS` itself rather than a list restated here.
 *
 * The probe writes a value no reader accepts, so the comparison cannot be the
 * element — an invalid value lands nowhere either way. What differs is the
 * diagnostic: the spelling a reader actually reads reports the value it
 * refused, and the one no reader looks at is silent. Repair KINDS are compared
 * rather than messages, because a reader is free to name the canonical key in
 * its own text and that difference is not the defect.
 */
describe("both spellings of every vocabulary key behave identically", () => {
  const camel = (k: string): string => k.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const kebab = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

  /** snake_case is refused by name, so it has no counterpart to agree with. */
  const dualOf = (k: string): string | undefined => {
    if (k.includes("_")) return undefined;
    const d = k.includes("-") ? camel(k) : kebab(k);
    return d === k ? undefined : d;
  };

  const signature = (over: Record<string, unknown>, type: string): string => {
    const doc = {
      version: "0.1",
      canvas,
      pages: [{ id: "p1", name: "P1", canvas, children: [{ id: "e", type, width: 100, height: 100, ...over }] }],
      activePageId: "p1"
    } as unknown as DesignDocument;
    const r = normalizeDesignDocument(doc);
    const kinds = r.repairs.map((x) => x.kind).sort().join(",");
    return `${JSON.stringify(r.document.pages[0].children[0])}|${kinds}`;
  };

  const TYPES = ["rect", "frame", "text", "path"];
  // `display` decides whether a layout reader runs at all, so a key is graded
  // with and without one: parity only counts where the key is reachable.
  const CONTEXTS: Array<Record<string, unknown>> = [{}, { display: "flex" }, { display: "grid" }];
  // Several probe VALUES, because one is not enough: a reader that only looks
  // inside a function (`backdrop-filter: blur(...)`) has nothing to say about a
  // bare unreadable string, so a single sentinel reported parity where the camel
  // spelling was in fact being ignored.
  const PROBES: unknown[] = ["__UNREADABLE__", "blur(4px)", 4, "4px", true];

  for (const key of CANONICAL_KEYS) {
    const dual = dualOf(key);
    if (!dual) continue;
    it(`${key} is read the same as ${dual}`, () => {
      for (const type of TYPES) {
        for (const ctx of CONTEXTS) {
          for (const probe of PROBES) {
            const a = signature({ ...ctx, [key]: probe }, type);
            const b = signature({ ...ctx, [dual]: probe }, type);
            expect(b, `${dual}=${JSON.stringify(probe)} on a ${type} in ${JSON.stringify(ctx)}`).toBe(a);
          }
        }
      }
    });
  }
});

/**
 * SVG's marker spellings name capabilities the document cannot carry: the
 * arrow's one head is always at the far end and has one shape, so a
 * `marker-start` (or a `marker-end: url(#…)`) that promoted a line would
 * promise the opposite of what the renderer draws — the same dishonesty that
 * cost `arrowStart` / `arrowEnd` / `arrowSize` their fields. The loud
 * `unknown property` is the whole answer, pointing at `arrow` / `arrowhead`.
 */
describe("a marker spelling is refused rather than half-honoured", () => {
  /** No `type`: only then does `inferElementType` run on the keys present. */
  const loadTypeless = (over: Record<string, unknown>) => {
    const doc = {
      version: "0.1",
      canvas,
      pages: [{ id: "p1", name: "P1", canvas, children: [{ id: "m", width: 4, height: 4, ...over }] }],
      activePageId: "p1"
    } as unknown as DesignDocument;
    return normalizeDesignDocument(doc);
  };

  it("keeps markerEnd and markerStart from promoting a line to an arrow", () => {
    for (const key of ["markerEnd", "markerStart"]) {
      const { document, repairs } = loadTypeless({ [key]: "url(#a)", dx: 10, dy: 10 });
      expect(document.pages[0].children[0].type, key).toBe("line");
      expect(
        repairs.some((r) => r.kind === "dropped-property" && r.message.includes(`"${key}"`)),
        key
      ).toBe(true);
    }
  });

  it("still promotes a line that says arrow or arrowhead", () => {
    expect(loadTypeless({ arrow: true, dx: 10, dy: 10 }).document.pages[0].children[0].type).toBe("arrow");
    expect(loadTypeless({ arrowhead: true, dx: 10, dy: 10 }).document.pages[0].children[0].type).toBe("arrow");
  });
});

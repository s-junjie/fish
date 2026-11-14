import { layoutOf } from "../src/core/dsl/layout-flat";
/**
 * `var()` custom properties and the non-px length forms (`rem`, constant
 * `calc` / `min` / `max` / `clamp`) are resolved ONCE, over the raw document,
 * before any branch reads a value.
 *
 * The two properties worth holding: a `var()` with no definition is REPORTED
 * (never silently shipped as a literal), and the length rewrite touches only
 * keys that HOLD a length — a text element whose `text` is the word "2rem" is
 * not a length and must survive untouched.
 */

import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { collectVariables, resolveValueTokens } from "../src/core/dsl/normalize/resolve-values";
import schema from "../src/core/dsl/fish.schema.json";

const frameDoc = (el: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  version: "0.1",
  pages: [{ id: "p1", name: "P", children: [{ id: "f", type: "frame", name: "f", x: 0, y: 0, width: 320, height: 200, ...el }] }],
  activePageId: "p1",
  ...extra
});

const textDoc = (el: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  version: "0.1",
  pages: [{ id: "p1", name: "P", children: [{ id: "t", type: "text", name: "t", x: 0, y: 0, width: 100, height: 24, text: "hi", ...el }] }],
  activePageId: "p1",
  ...extra
});

const only = (out: { document: any }) => out.document.pages[0].children[0];

describe("P1.9 — CSS custom properties resolve at normalize time", () => {
  it("resolves a var() against the document's variables, with or without --", () => {
    const out = normalizeDesignDocument(frameDoc(
      { display: "flex", gap: "var(--space)", padding: "var(--gutter)" },
      { variables: { "--space": 12, gutter: "1rem" } }
    ) as any);
    expect(layoutOf(only(out))).toMatchObject({ gap: 12, padding: 16 });
  });

  it("uses the fallback when the name is undefined", () => {
    const out = normalizeDesignDocument(frameDoc(
      { display: "flex", gap: "var(--missing, 8)" },
      { variables: { space: 4 } }
    ) as any);
    expect(layoutOf(only(out))!.gap).toBe(8);
  });

  it("reports an unresolved var() instead of shipping it as a literal", () => {
    const out = normalizeDesignDocument(frameDoc({ display: "flex", gap: "var(--missing)" }) as any);
    const hit = out.repairs.find((r) => r.message.includes("var(--missing)"));
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBeUndefined();
  });

  it("folds rem and calc() on corner radii and per-side border widths", () => {
    const out = normalizeDesignDocument(frameDoc({
      type: "rect",
      "border-top-left-radius": "1rem",
      "border-top-width": "calc(1px + 1px)"
    }) as any);
    const el = only(out);
    expect(el.borderRadius).toEqual([16, 0, 0, 0]);
    expect(el.strokes?.[0]?.sides).toMatchObject({ top: 2 });
    expect(out.repairs.filter((r) => r.severity !== "info")).toEqual([]);
  });

  it("folds rem inside grid track lists without touching fr shares", () => {
    const out = normalizeDesignDocument(frameDoc({
      display: "grid",
      "grid-template-columns": "16rem 1fr",
      "grid-template-rows": "repeat(2, 4rem 1fr)"
    }) as any);
    const layout = layoutOf(only(out));
    expect(layout?.columnSizes).toEqual([256, { fr: 1 }]);
    expect(layout?.rowSizes).toEqual([64, { fr: 1 }, 64, { fr: 1 }]);
    expect(out.repairs.filter((r) => r.severity !== "info")).toEqual([]);
  });

  it("keeps the variables object on the normalized document", () => {
    const out = normalizeDesignDocument(frameDoc({}, { variables: { "--space": 12 } }) as any);
    expect(out.document.variables).toEqual({ "--space": 12 });
    expect(out.repairs.some((r) => r.message.includes('unknown top-level property "variables"'))).toBe(false);
  });

  it("exposes the schema property an external author reads", () => {
    expect(schema.properties.variables).toBeTruthy();
  });
});

describe("P1.4 — non-px length forms", () => {
  it("folds rem to px wherever a length lives", () => {
    const out = normalizeDesignDocument(textDoc({ style: { fontSize: "1.5rem", letterSpacing: "0.25rem" } }) as any);
    expect(only(out).style.fontSize).toBe(24);
    expect(only(out).style.letterSpacing).toEqual(4);
  });

  it("folds a constant calc() and min()/max()/clamp()", () => {
    const out = normalizeDesignDocument(frameDoc({
      display: "flex", gap: "calc(8px + 8px)", padding: "max(16px, 12px) 1rem"
    }) as any);
    expect(layoutOf(only(out))).toMatchObject({ gap: 16, padding: [16, 16, 16, 16] });
  });

  it("clamps a bound written as clamp()", () => {
    const out = normalizeDesignDocument(frameDoc({ sizing: { minWidth: "clamp(40px, 80px, 100px)", width: "fill" } }) as any);
    expect(only(out).sizing.minWidth).toBe(80);
  });

  it("leaves a viewport unit for the bound reader to report, rather than guessing", () => {
    const out = normalizeDesignDocument(frameDoc({ sizing: { minWidth: "50vw" } }) as any);
    const hit = out.repairs.find((r) => r.path.endsWith("/sizing/minWidth"));
    expect(hit?.message).toContain("vw");
  });

  it("accepts percentage and mixed calc() bounds without repair", () => {
    const out = normalizeDesignDocument(
      frameDoc({
        sizing: { minWidth: "50%", maxWidth: "calc(100% - 16px)" }
      }) as any
    );
    expect(out.repairs.find((r) => r.path.includes("/sizing/"))).toBeUndefined();
    expect(only(out).sizing).toMatchObject({
      minWidthExpr: "50%",
      maxWidthExpr: "calc(100% - 16px)"
    });
  });

  it("does NOT rewrite a length-looking string that is really text content", () => {
    const out = normalizeDesignDocument(textDoc({ text: "2rem of space" }) as any);
    expect(only(out).content).toBe("2rem of space");
  });
});

describe("resolve-values — the pure helper", () => {
  it("collects variables under a --stripped name", () => {
    expect(collectVariables({ "--a": 1, b: "2px", c: { nested: true } })).toEqual({ a: 1, b: "2px" });
  });

  it("returns unresolved hits with their path", () => {
    const { unresolved } = resolveValueTokens({ a: "var(--x)" }, {});
    expect(unresolved).toEqual([{ path: "/a", text: "var(--x)" }]);
  });

  /**
   * The bitmap table is skipped rather than walked, because the tables are the
   * bulk of a photo-heavy document: `hasVarCall` cannot answer without scanning
   * the whole base64 payload, and that scan is what a save pays. Skipping is
   * only sound while nothing in an `AssetRef` is a length or a `var()`, so this
   * test also pins that the rest of the document still resolves.
   */
  it("leaves the bitmap table as it stands, without reporting its strings", () => {
    const assets = [
      { id: "a1", name: "a.svg", uri: 'data:image/svg+xml,<svg fill="var(--brand)"/>', width: 4000, height: 4000 }
    ];
    const input = { variables: { "--gap": "1rem" }, assets, layout: { gap: "var(--gap)" } };
    const { value, unresolved } = resolveValueTokens(input, collectVariables(input.variables));
    expect((value as { assets: unknown }).assets).toBe(assets);
    expect((value as { layout: { gap: string } }).layout.gap).toBe("16px");
    expect(unresolved).toEqual([]);
  });
});

/**
 * The gap this closes: the pass leaves `%` and `em` as written, and a reader
 * that used `asNumber` then read `"5%"` as FIVE PIXELS with an empty repair list
 * — geometry that looks applied and is not. Every field that holds a px length
 * must say so instead.
 */
describe("P1.4 — a % or em length is reported by the field that holds it", () => {
  it("reports a percentage gap instead of reading it as px", () => {
    const out = normalizeDesignDocument(frameDoc({ display: "flex", gap: "5%" }) as any);
    const hit = out.repairs.find((r) => r.path.endsWith("/gap"));
    expect(hit?.message).toContain("5%");
    expect(layoutOf(only(out))!.gap).toBeUndefined();
  });

  it("reports an em gap", () => {
    const out = normalizeDesignDocument(frameDoc({ display: "flex", gap: "2em" }) as any);
    expect(out.repairs.find((r) => r.path.endsWith("/gap"))?.message).toContain("em");
  });

  it("reports a percentage padding", () => {
    const out = normalizeDesignDocument(frameDoc({ display: "flex", padding: "5%" }) as any);
    expect(out.repairs.find((r) => r.path.endsWith("/padding"))?.message).toContain("5%");
  });

  it("reports a percentage margin", () => {
    const out = normalizeDesignDocument(frameDoc({ margin: "5%" }) as any);
    expect(out.repairs.find((r) => r.path.endsWith("/margin"))?.message).toContain("5%");
  });

  it("reports a percentage font-size and falls back to the default", () => {
    const out = normalizeDesignDocument(textDoc({ style: { fontSize: "150%" } }) as any);
    const hit = out.repairs.find((r) => r.path.endsWith("/style/fontSize"));
    expect(hit?.message).toContain("150%");
    expect(only(out).style.fontSize).toBe(24);
  });

  it("reports a percentage x instead of placing the element 5px in", () => {
    const out = normalizeDesignDocument(frameDoc({ x: "5%" }) as any);
    expect(out.repairs.find((r) => r.path.endsWith("/x"))?.message).toContain("%");
    expect(only(out).x).toBe(0);
  });

  it("folds rem inside an object-form box shape rather than zeroing its sides", () => {
    const out = normalizeDesignDocument(frameDoc({
      margin: { top: "2rem", bottom: 4 },
      display: "flex", padding: { top: "1rem", left: 8 }
    }) as any);
    expect(only(out).margin).toEqual([32, 0, 4, 0]);
    expect(layoutOf(only(out))!.padding).toEqual([16, 0, 0, 8]);
    expect(out.repairs.find((r) => r.path.endsWith("/margin"))).toBeUndefined();
  });

  it("folds rem for a flat margin object", () => {
    const out = normalizeDesignDocument(frameDoc({ margin: { top: "2rem", bottom: 4 } }) as any);
    expect(only(out).margin).toEqual([32, 0, 4, 0]);
  });

  it("reports a % side of a box shape instead of swallowing it as 0", () => {
    const out = normalizeDesignDocument(frameDoc({ margin: { top: "50%", bottom: 4 } }) as any);
    const hit = out.repairs.find((r) => r.path.endsWith("/margin"));
    expect(hit?.message).toContain("50%");
    expect(only(out).margin).toBeUndefined();
  });

  it("resolves var() inside calc() and unbindable props from doc.tokens[] respecting node numberMode", () => {
    const tokens = [
      { id: "tok_space", name: "space/md", type: "number", value: 16, category: "spacing", modes: { compact: 8 } },
      { id: "tok_ink", name: "color/ink", type: "color", value: "#111111" }
    ];
    const out = normalizeDesignDocument({
      version: "0.1",
      pages: [
        {
          id: "p1",
          name: "P",
          children: [
            {
              id: "f",
              type: "frame",
              display: "flex",
              width: 320,
              height: 200,
              children: [
                {
                  id: "c1",
                  type: "rect",
                  width: "calc(100% - var(--space-md))",
                  margin: "var(--space-md)"
                },
                {
                  id: "c2",
                  type: "rect",
                  numberMode: "compact",
                  width: "calc(100% - var(--space-md))",
                  margin: "var(--space-md)"
                }
              ]
            }
          ]
        }
      ],
      activePageId: "p1",
      tokens,
      numberModes: [{ id: "default", name: "Default" }, { id: "compact", name: "Compact" }],
      activeNumberMode: "default"
    } as any);
    expect(out.repairs.filter((r) => r.kind === "token")).toEqual([]);
    const [c1, c2] = only(out).children;
    expect(c1.width).toBe(304);
    expect(c1.margin).toBe(16);
    expect(c2.width).toBe(312);
    expect(c2.margin).toBe(8);
  });

  it("gives doc.variables precedence over doc.tokens[] inside calc() expressions", () => {
    const out = normalizeDesignDocument(
      frameDoc(
        { children: [{ id: "c", type: "rect", width: "calc(100% - var(--space-md))" }] },
        {
          variables: { "--space-md": "24px" },
          tokens: [{ id: "tok_space", name: "space/md", type: "number", value: 16, category: "spacing" }]
        }
      ) as any
    );
    expect(only(out).children[0].width).toBe(296);
  });
});

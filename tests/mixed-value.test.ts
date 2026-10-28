import { describe, it, expect } from "vitest";
import { MIXED_LABEL, resolveAcross, resolveValues } from "../src/ui/inspector/mixed";
import { RectElement } from "../src/core/dsl/types";

const rect = (id: string, extra: Partial<RectElement> = {}): RectElement => ({
  id,
  type: "rect",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extra
});

describe("resolveAcross", () => {
  it("reports one value when every layer agrees", () => {
    const r = resolveAcross([rect("a", { borderRadius: 8 }), rect("b", { borderRadius: 8 })], (el) =>
      (el as { borderRadius?: number }).borderRadius ?? 0
    );
    expect(r).toEqual({ value: 8, mixed: false });
  });

  it("reports mixed when they do not, keeping the first as the reference", () => {
    const r = resolveAcross([rect("a", { borderRadius: 8 }), rect("b", { borderRadius: 12 })], (el) =>
      (el as { borderRadius?: number }).borderRadius ?? 0
    );
    expect(r.mixed).toBe(true);
    expect(r.value).toBe(8);
  });

  it("treats an absent property as a value, not as zero", () => {
    // One layer stores a radius and another stores none: they differ. Collapsing
    // the absent one to 0 would report a field that is set to nothing.
    const r = resolveAcross(
      [rect("a", { borderRadius: 0 }), rect("b")],
      (el) => ((el as { borderRadius?: number }).borderRadius ?? 0)
    );
    expect(r.mixed).toBe(false);
    const absent = resolveAcross(
      [rect("b"), rect("a", { borderRadius: 4 })],
      (el) => (el as { borderRadius?: number }).borderRadius
    );
    expect(absent.mixed).toBe(true);
  });

  it("is never mixed for one element — there is nothing to compare", () => {
    expect(resolveAcross([rect("a", { borderRadius: 3 })], (el) => (el as { borderRadius?: number }).borderRadius).mixed).toBe(false);
    expect(resolveAcross([], () => 1).mixed).toBe(false);
  });

  it("compares with Object.is, so NaN agrees with NaN and 0 with -0 does not", () => {
    // Two NaNs ARE the same value here — a field reading NaN twice is not a
    // selection that disagrees with itself. A signed zero is a different number,
    // and `===` would call it the same one.
    expect(resolveValues([NaN, NaN]).mixed).toBe(false);
    expect(resolveValues([0, -0]).mixed).toBe(true);
    expect(resolveValues([1, 1, 1]).mixed).toBe(false);
  });

  it("names the mixed state in a word, not a key", () => {
    // The panel must not ship a `t()` for this — see mixed.ts. Asserted so the
    // absence is a decision somebody cannot undo by accident.
    expect(MIXED_LABEL).toBe("Mixed");
  });
});
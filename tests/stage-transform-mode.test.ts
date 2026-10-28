import { describe, it, expect } from "vitest";
import { pageNeedsBackdropSafeStage } from "../src/ui/canvas/stage-transform-mode";
import { DesignElement } from "../src/core/dsl/types";

// The predicate gates `LESSONS_LEARNED.md` #166, and it is a conjunction: the
// Chromium bug needs a backdrop-filter to drop AND a blend mode to trigger it.
// An arm that answers "yes" on one half alone pays the `<g transform>` in the
// one case where it was never needed.
const el = (over: Partial<DesignElement> & { id: string }): DesignElement =>
  ({ type: "rect", x: 0, y: 0, width: 10, height: 10, ...over } as unknown as DesignElement);

const blur = { type: "backdrop-blur" as const, blur: 12, enabled: true };

describe("the backdrop-safe stage is taken only on both halves", () => {
  it("stays on the composited path with neither", () => {
    expect(pageNeedsBackdropSafeStage([el({ id: "a" })])).toBe(false);
  });

  it("stays on the composited path with a blur and no blend mode", () => {
    expect(pageNeedsBackdropSafeStage([el({ id: "a", effects: [blur] })])).toBe(false);
  });

  it("stays on the composited path with a blend mode and no blur", () => {
    expect(pageNeedsBackdropSafeStage([el({ id: "a", blendMode: "multiply" })])).toBe(false);
  });

  it("takes the group when both are present", () => {
    expect(pageNeedsBackdropSafeStage([el({ id: "a", effects: [blur], blendMode: "multiply" })])).toBe(true);
  });

  it("finds each half in a different element, at any depth", () => {
    const tree = [el({ id: "f", type: "frame", children: [
      el({ id: "g", type: "frame", children: [el({ id: "deep", effects: [{ ...blur, type: "liquid-glass" } as any] })] }),
      el({ id: "blend", blendMode: "screen" })
    ] } as any)];
    expect(pageNeedsBackdropSafeStage(tree)).toBe(true);
  });

  it("reads a blend mode off a paint, not only off the element", () => {
    const paints = [el({ id: "a", effects: [blur],
      fills: [{ type: "solid", color: "#fff", blendMode: "overlay" } as any] })];
    expect(pageNeedsBackdropSafeStage(paints)).toBe(true);
    const strokes = [el({ id: "a", effects: [blur],
      strokes: [{ color: "#000", width: 1, blendMode: "overlay" } as any] })];
    expect(pageNeedsBackdropSafeStage(strokes)).toBe(true);
  });

  it("ignores a blend mode that is normal", () => {
    expect(pageNeedsBackdropSafeStage([el({ id: "a", effects: [blur], blendMode: "normal" })])).toBe(false);
  });

  it("ignores a disabled effect", () => {
    const off = [el({ id: "a", effects: [{ ...blur, enabled: false }], blendMode: "multiply" })];
    expect(pageNeedsBackdropSafeStage(off)).toBe(false);
  });
});

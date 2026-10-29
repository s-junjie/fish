import { describe, it, expect } from "vitest";
import { holdMaster, heldMaster } from "../src/core/interactions/detached-masters";
import { measureText, setTextMeasurer, type TextMeasureSpec } from "../src/core/geometry/text-measure";
import type { ComponentElement } from "../src/core/dsl/types";

/**
 * Pins the reset in `tests/setup.ts`, which is the reason the two cases below
 * cannot see each other. Without an afterEach hook these two would share the
 * module under `isolate: false`, so the second would find the first's measurer
 * and its held master — exactly the leak that made an unrelated file go red
 * when the file set changed.
 */
const calls: string[] = [];

const SPEC: TextMeasureSpec = {
  fontFamily: "system-ui",
  fontSize: 16,
  fontWeight: 400,
  lineHeight: 20,
  letterSpacing: 0
};

describe("module state does not outlive a test", () => {
  it("leaves a measurer and a held master behind on purpose", () => {
    setTextMeasurer((content) => {
      calls.push(content);
      return { width: 1234, height: 12, lines: 1 };
    });
    holdMaster({ id: "cmp_leaked", type: "component", x: 0, y: 0, width: 10, height: 10 } as unknown as ComponentElement);

    // Both seams really are installed — otherwise the next case would pass for
    // the wrong reason.
    expect(measureText("hello", SPEC).width).toBe(1234);
    expect(heldMaster("cmp_leaked")).not.toBeNull();
  });

  it("starts clean: no measurer, no master, no cached measurement", () => {
    expect(heldMaster("cmp_leaked")).toBeNull();

    const before = calls.length;
    const measured = measureText("hello", SPEC);
    expect(calls.length).toBe(before);
    // The analytic fallback is ~0.6em per glyph; the leaked measurer's 1234 is
    // the value this must not be.
    expect(measured.width).not.toBe(1234);
    expect(measured.width).toBeGreaterThan(0);
  });
});

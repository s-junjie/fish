import { describe, it, expect, afterEach } from "vitest";
import { measureSpan, perfTotals, perfClear } from "../src/core/perf";

const g = globalThis as unknown as { window?: unknown; __FISH_PERF__?: boolean };

afterEach(() => {
  perfClear();
  delete g.window;
  delete g.__FISH_PERF__;
});

/**
 * The perf flag is documented as switchable "from the console at any time". It
 * used to be snapshotted while the module loaded, so a flag set afterwards
 * changed nothing and `__FISH_BRIDGE__.perf()` stayed empty.
 */
describe("__FISH_PERF__", () => {
  it("is off until a flag exists, even after the module has loaded", () => {
    g.window = g;
    measureSpan("before", () => {});
    expect(perfTotals().before).toBeUndefined();
  });

  it("starts recording the moment the console sets it", () => {
    g.window = g;
    g.__FISH_PERF__ = true;
    measureSpan("after", () => {});
    expect(perfTotals().after?.count).toBe(1);
  });

  it("stops again when the flag is cleared", () => {
    g.window = g;
    g.__FISH_PERF__ = true;
    measureSpan("on", () => {});
    g.__FISH_PERF__ = false;
    measureSpan("off", () => {});
    expect(perfTotals().on?.count).toBe(1);
    expect(perfTotals().off).toBeUndefined();
  });
});

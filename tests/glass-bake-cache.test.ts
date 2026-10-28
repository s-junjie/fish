import { describe, expect, it } from "vitest";
import { BAKE_CACHE_BYTES, createBakeCache, dataUriCost } from "../src/ui/canvas/glass-bake-cache";

/**
 * The bound is load-bearing, not a tuning knob.
 *
 * `bakeGlass` is pure in (geometry, parameters, display scale), so the cache is
 * what turns a per-frame cost into a per-change one. When the cache was bounded
 * by entry count at 96, any document with more glass than that hit a working set
 * larger than the cache, and a cyclic sweep over a working set larger than the
 * cache misses on every access: 540 elements re-baked 3.1 times each per zoom
 * tick, 65,082 PNG encodes and 12.5 s of encoding for a 16.7 ms frame. These are
 * the properties that failure needed, and each one has to stay asserted.
 */

const costOf = (n: number) => () => n;

/**
 * Heap cost of one baked element, measured.
 *
 * Three PNG data URIs of a 150x110 panel at dpr 2: ~16.6 KB of characters each,
 * doubled for UTF-16, so ~97.5 KB per element. Rounded up here so the budget
 * assertions fail on a real regression rather than on float noise.
 */
const ENTRY_HEAP_BYTES = 100 * 1024;

describe("createBakeCache", () => {
  it("holds a whole render pass when the budget is sized for one", () => {
    // The regression, stated as an assertion. A render pass reads every glass
    // element on the page in one sweep, so the cache has to hold the whole sweep;
    // with the old 96-ENTRY bound a 540-element page swept 540 and kept 96, which
    // is why it missed on every access rather than merely missing sometimes.
    const cache = createBakeCache<number>(540 * ENTRY_HEAP_BYTES, costOf(ENTRY_HEAP_BYTES));
    for (let i = 0; i < 540; i++) cache.set(`g_${i}`, i);
    expect(cache.size()).toBe(540);
    for (let i = 0; i < 540; i++) expect(cache.get(`g_${i}`)).toBe(i);
  });

  it("cannot be starved by a count the caller never chose", () => {
    // The byte bound is the point: entry sizes span orders of magnitude between a
    // chip and a poster, so any fixed COUNT reintroduces the cliff somewhere.
    const big = createBakeCache<string>(1000, () => 500);
    const small = createBakeCache<string>(1000, () => 1);
    big.set("a", "a");
    big.set("b", "b");
    small.set("a", "a");
    small.set("b", "b");
    expect(big.size()).toBe(2);
    expect(small.size()).toBe(2);
  });

  it("evicts oldest-first once over budget", () => {
    const cache = createBakeCache<string>(100, costOf(40));
    cache.set("a", "a");
    cache.set("b", "b");
    cache.set("c", "c");
    // 120 > 100: "a" is the oldest insertion and goes first.
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("b");
    expect(cache.get("c")).toBe("c");
  });

  it("evicts until it is back under budget, not just once", () => {
    const cache = createBakeCache<string>(100, costOf(40));
    for (const k of ["a", "b", "c", "d", "e"]) cache.set(k, k);
    expect(cache.bytes()).toBeLessThanOrEqual(100);
    expect(cache.get("e")).toBe("e");
  });

  it("keeps the entry it was just given, even when it alone exceeds the budget", () => {
    // A single bake over the whole budget still has to reach its caller. Dropping
    // it would turn an over-budget document into a document with no glass at all.
    const cache = createBakeCache<string>(10, costOf(999));
    cache.set("only", "only");
    expect(cache.get("only")).toBe("only");
    expect(cache.bytes()).toBe(999);
  });

  it("does not double-count a key that is set twice", () => {
    // Accounting that drifts here evicts live entries, which presents as exactly
    // the cache-too-small bug this module exists to remove. The assertion is on
    // `bytes`, not on survival: two inserts of a 40-byte value are 40 bytes.
    const cache = createBakeCache<string>(100, costOf(40));
    cache.set("a", "a");
    cache.set("a", "a");
    expect(cache.size()).toBe(1);
    expect(cache.bytes()).toBe(40);
  });

  it("charges the newest value, not the one it replaced", () => {
    const cache = createBakeCache<string>(100, (v) => (v === "small" ? 10 : 90));
    cache.set("k", "big");
    cache.set("k", "small");
    expect(cache.bytes()).toBe(10);
  });

  it("accounts nothing for an evicted entry", () => {
    const cache = createBakeCache<string>(100, costOf(40));
    cache.set("a", "a");
    cache.set("b", "b");
    expect(cache.bytes()).toBe(80);
    cache.set("c", "c");
    expect(cache.bytes()).toBe(80);
    cache.set("d", "d");
    expect(cache.bytes()).toBe(80);
  });

  it("clears to zero on both axes", () => {
    const cache = createBakeCache<string>(100, costOf(40));
    cache.set("a", "a");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.bytes()).toBe(0);
  });

  it("reports undefined for a miss and for an empty cache", () => {
    const cache = createBakeCache<string>(100, costOf(1));
    expect(cache.get("nope")).toBeUndefined();
    cache.set("a", "a");
    expect(cache.get("nope")).toBeUndefined();
  });
});

describe("BAKE_CACHE_BYTES", () => {
  it("covers one full render sweep of a large page", () => {
    // The number is a judgement, so it gets asserted rather than trusted. One
    // sweep is the requirement, NOT one sweep per zoom rung: a rung that ages out
    // costs one cold bake when the gesture crosses it, and paying that is correct,
    // whereas failing to hold the current rung costs a bake on EVERY frame. So
    // the budget has to clear the mounted set, not the mounted set times the
    // rungs. 540 mounted glass elements is the worst case measured
    // (`docs/CANVAS_PERF.md`).
    const MOUNTED = 540;
    expect(BAKE_CACHE_BYTES).toBeGreaterThanOrEqual(MOUNTED * ENTRY_HEAP_BYTES);
  });

  it("actually holds that sweep, rather than merely having the budget for it", () => {
    const cache = createBakeCache<number>(BAKE_CACHE_BYTES, costOf(ENTRY_HEAP_BYTES));
    for (let i = 0; i < 540; i++) cache.set(`g_${i}`, i);
    expect(cache.size()).toBe(540);
    expect(cache.bytes()).toBeLessThanOrEqual(BAKE_CACHE_BYTES);
  });
});

describe("dataUriCost", () => {
  it("counts two bytes per character, plus the fixed term", () => {
    // A data URI is a JS string; PNG is ASCII, so length IS the code unit count.
    expect(dataUriCost(["abcd"], 0)).toBe(8);
    expect(dataUriCost(["abcd"], 256)).toBe(8 + 512);
  });

  it("ignores absent maps rather than charging for them", () => {
    // A bake with Refraction at 0 has no field, and a rim that spread past the
    // band has no plate. Charging for the nulls would bound the cache on a
    // fiction and evict live entries early.
    expect(dataUriCost([null, "ab", undefined], 0)).toBe(4);
    expect(dataUriCost([], 0)).toBe(0);
  });
});
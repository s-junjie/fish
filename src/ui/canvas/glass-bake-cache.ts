/**
 * The cache behind `bakeGlass`, bounded by bytes.
 *
 * It exists because a glass bake is not cheap: an exact Euclidean distance pass
 * over the element, a raster, and a PNG encode per map, three maps per element.
 * It is a pure function of the element's geometry, its glass parameters and the
 * scale the maps will be displayed at, so a memo turns a per-frame cost into a
 * per-change one — but only if the cache is big enough to be a cache.
 *
 * The policy is bounded by BYTES rather than by entry count. An entry is three
 * PNG data URIs whose size is set by the element's box, so no fixed count can be
 * right for both a chip and a poster, and a count limit puts the same cliff back
 * at whatever entry count happens to fit the average. Worse, the cliff is not a
 * cliff but a fall: the working set of one render pass is every glass element on
 * the page, so once the working set exceeds the cache the pass evicts what the
 * very pass it is running still needs, and a cyclic sweep over a working set
 * larger than the cache misses on every single access. Measured on a zoom burst,
 * 540 glass elements re-baked 3.1 times each per tick — 65,082 PNG encodes,
 * 12.5 s of encoding, 352 MB of string allocation — for a frame that costs
 * 16.7 ms once the bake is a hit. The break sat exactly on the old 96-entry
 * limit: 96 elements encoded zero times, 112 encoded 3.1 times apiece.
 *
 * Eviction is insertion-ordered, which is a deliberate simplification. A true LRU
 * needs a touch on every hit, and a touch on every hit would have to write to a
 * `Map` during a Preact render — the one place in the canvas where a side effect
 * on shared state is hardest to reason about. Insertion order is the policy that
 * behaves correctly here: a bake is produced once per change and then read
 * repeatedly for as long as the view is still, so what ages out first is exactly
 * the content that changed longest ago.
 */

/**
 * Heap ceiling for baked glass, in bytes.
 *
 * Sized to hold a large page's working set plus a zoom gesture's worth of scale
 * rungs: several hundred panels of a few tens of KB each. Trading heap for hits is
 * the right way round, because the miss this budget avoids costs milliseconds per
 * element — so it only has to be wrong in the direction of keeping too much.
 */
export const BAKE_CACHE_BYTES = 96 * 1024 * 1024;

/** A cache with an explicit accounting surface, so its bound can be asserted. */
export interface BakeCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  /** Number of live entries. Diagnostics and tests; not on the render path. */
  size(): number;
  /** Bytes currently held, as `costOf` reports them. */
  bytes(): number;
  clear(): void;
}

/**
 * @param budgetBytes Ceiling on `costOf` summed over live entries.
 * @param costOf Heap cost of one value. Called once per insert and once per
 *   eviction, so it must be cheap and stable for a given value.
 */
export function createBakeCache<T>(budgetBytes: number, costOf: (value: T) => number): BakeCache<T> {
  const entries = new Map<string, T>();
  let bytes = 0;

  return {
    get(key) {
      return entries.get(key);
    },

    set(key, value) {
      // Re-setting a live key must not double-count. The render path cannot reach
      // this — a hit returns before the bake runs — but the accounting has to be
      // right anyway, because a cache that leaks bytes evicts live entries and
      // that failure looks exactly like the bug this module was written to fix.
      const replaced = entries.get(key);
      if (replaced !== undefined) bytes -= costOf(replaced);
      entries.set(key, value);
      bytes += costOf(value);

      // The entry just inserted is never the eviction candidate. A single value
      // over the whole budget still has to reach its caller; dropping it would
      // turn an over-budget document into a document with no glass at all.
      while (bytes > budgetBytes) {
        const oldest = entries.keys().next();
        if (oldest.done || oldest.value === key) break;
        const dropped = entries.get(oldest.value);
        entries.delete(oldest.value);
        bytes -= dropped === undefined ? 0 : costOf(dropped);
      }
    },

    size: () => entries.size,
    bytes: () => bytes,
    clear() {
      entries.clear();
      bytes = 0;
    }
  };
}

/**
 * Heap cost of a baked glass, in bytes.
 *
 * A data URI is a JS string — two bytes per code unit, and PNG output is ASCII,
 * so the string length is the code unit count. The fixed term stands in for the
 * bake object itself and the numbers beside its URIs.
 */
export function dataUriCost(uris: Array<string | null | undefined>, fixed = 256): number {
  let chars = fixed;
  for (const uri of uris) if (uri) chars += uri.length;
  return chars * 2;
}
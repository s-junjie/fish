/**
 * Frame-cost marks. Off unless something turns them on.
 *
 * There was no way to answer "where did that frame go" from inside the app:
 * `performance.mark` appeared nowhere in `src/`, and a CPU profile of the minified
 * bundle names nothing. These are the seams the measurements actually landed on —
 * the drag/resize commit, the snap-candidate list, the document commit, and the
 * layer tree's plan — so a regression shows up as a number rather than a hunch.
 *
 * Enabled by `window.__FISH_PERF__ = true` before the shell boots (a query flag in
 * a probe), or from the console at any time. Marks are cheap when off: one
 * `typeof` per call site, no allocation.
 */

const scope = typeof window !== "undefined" ? ((window as any).__FISH_PERF__ ? (window as any).performance : undefined) : undefined;

export function perfEnabled(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).__FISH_PERF__);
}

/** Times `body` and records it as `name`. Returns whatever `body` returned. */
export function measureSpan<T>(name: string, body: () => T): T {
  if (!scope) return body();
  const start = performance.now();
  try {
    return body();
  } finally {
    performance.measure(name, { start, end: performance.now() });
  }
}

/**
 * The running total for one mark name, in milliseconds.
 *
 * Averages are the wrong shape here: the thing that matters is the frame that
 * cost 250 ms, and an average hides exactly that.
 */
export function perfTotals(): Record<string, { count: number; totalMs: number; maxMs: number }> {
  const out: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
  for (const entry of performance.getEntriesByType("measure")) {
    const row = (out[entry.name] ??= { count: 0, totalMs: 0, maxMs: 0 });
    row.count += 1;
    row.totalMs += entry.duration;
    if (entry.duration > row.maxMs) row.maxMs = entry.duration;
  }
  return out;
}

export function perfClear(): void {
  performance.clearMeasures();
}

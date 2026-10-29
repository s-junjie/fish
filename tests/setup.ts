import { afterEach } from "vitest";
import { clearHeldMasters } from "../src/core/interactions/detached-masters";
import { clearTextMeasureCache, setTextMeasurer } from "../src/core/geometry/text-measure";

/**
 * The module state `isolate: false` would otherwise share between test FILES.
 *
 * Shared modules are what keeps this suite at ~45 s instead of ~200 s, and the
 * price is that a singleton outlives the file that built it: a measurer left
 * installed by one file answered for every later file, and a held component
 * definition (a cut master, held for the session by design) made a following
 * test see a master its document never had. Both fail as "this test is flaky
 * when run with others", which is the worst kind of red — it depends on file
 * order, so it moves when an unrelated file is added.
 *
 * Resetting after every test rather than after each file costs nothing — a
 * `Map.clear()` and a field assignment — and covers the case that a file leaks
 * into itself as well as into the next one.
 *
 * `npm run test:isolated` remains the run to trust when a red does not
 * reproduce here: it re-imports every file, so it cannot be fooled by state
 * this list does not name yet.
 */
afterEach(() => {
  clearHeldMasters();
  clearTextMeasureCache();
  // Restores the analytic fallback, and clears the cache with it.
  setTextMeasurer(null);
});

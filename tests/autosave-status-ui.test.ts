import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { t } from "../src/i18n";

const repoFile = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

const CONTROLLER = "src/core/persistence/autosave-controller.ts";
const BADGE = "src/ui/toolbar/AutosaveBadge.tsx";

/**
 * The kinds `AutosaveStatus` can take. A kind the badge never names falls
 * through to the "auto-save off" branch, which is how `error` and
 * `file-unavailable` both ended up reading as "you never turned auto-save on".
 */
function emittedKinds(): string[] {
  const src = read(CONTROLLER);
  const start = src.indexOf("export type AutosaveStatus");
  const block = src.slice(start, src.indexOf("\n\nexport", start));
  return [...block.matchAll(/kind: "([a-z-]+)"/g)].map((m) => m[1]);
}

describe("autosave status reaches the UI", () => {
  const kinds = emittedKinds();

  it("reads every kind the controller declares", () => {
    expect(kinds).toEqual([
      "local-saving",
      "local-saved",
      "file-writing",
      "file-saved",
      "file-unavailable",
      "error"
    ]);
  });

  it.each(kinds)("names %s in the badge", (kind) => {
    expect(read(BADGE)).toContain(`"${kind}"`);
  });

  /**
   * `t()` returns the key path itself when a key is missing (:919), so a typo
   * ships as `autosave.statusError` in the title bar rather than failing.
   */
  it("translates every autosave key the badge asks for", () => {
    const keys = new Set(
      [...read(BADGE).matchAll(/"(autosave\.[A-Za-z]+)"/g)].map((m) => m[1])
    );
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(t(key), key).not.toBe(key);
    }
  });
});

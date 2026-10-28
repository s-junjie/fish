import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A rig that nothing runs is not a rig.
 *
 * This is the "is it registered?" half of the testing rule, and it is the half
 * that fails silently: a script under `scripts/` looks maintained, it is in the
 * diff next to real work, and nobody notices that no entry point names it. The
 * other half — a rig must derive the list it grades rather than restate it —
 * cannot be asserted in general, so it is enforced where it applies:
 * `tests/type-coverage.test.ts` reads the element union instead of copying it.
 *
 * Roots are the two files a human or CI actually invokes: `package.json` and
 * the Vite config. Everything reachable from them by name is a rig that runs;
 * everything else in `scripts/` is a file that merely exists.
 */
const REPO = join(__dirname, "..");

const ROOTS = ["package.json", "vite.config.ts"];
const RIG_EXTENSIONS = [".mjs", ".sh", ".ps1"];

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf-8");
}

/** Top-level scripts only: `lib/` and `fixtures/` are modules and data. */
function rigs(): string[] {
  return readdirSync(join(REPO, "scripts"), { withFileTypes: true })
    .filter((e) => e.isFile() && RIG_EXTENSIONS.some((ext) => e.name.endsWith(ext)))
    .map((e) => `scripts/${e.name}`)
    .sort();
}

/**
 * Close over "named by something that itself runs": `shot.sh` is not in any
 * npm script, but `build-fish-agent-kit.mjs` copies it into the kit, and that
 * one is. A single pass is not enough, so iterate until nothing new is named.
 */
function reachable(): Set<string> {
  const pool = new Map(rigs().map((rel) => [rel, read(rel)]));
  const known = new Set<string>();
  let frontier = ROOTS.map(read).join("\n");
  for (;;) {
    const before = known.size;
    for (const [rel, source] of pool) {
      if (known.has(rel)) continue;
      const name = rel.slice("scripts/".length);
      if (frontier.includes(name)) known.add(rel);
    }
    if (known.size === before) break;
    frontier += "\n" + [...known].map((rel) => pool.get(rel)!).join("\n");
  }
  return known;
}

describe("every rig is reachable from an entry point", () => {
  const known = reachable();

  it("finds rigs to grade, so a broken scan cannot pass as an empty one", () => {
    expect(rigs().length).toBeGreaterThan(10);
    expect(known.size).toBeGreaterThan(0);
  });

  it("names every script under scripts/ from a root, directly or by reference", () => {
    // Unnamed here means: give it an npm script, have a registered script call
    // it, or delete it. Do not add it to an exception list — an allowlist is
    // how a rig ends up graded on whether it exists rather than whether it ran.
    const orphans = rigs().filter((rel) => !known.has(rel));
    expect(orphans).toEqual([]);
  });
});

describe("the e2e runner discovers every spec", () => {
  const runner = read("scripts/run-e2e.mjs");

  it("matches specs by the suffix tests/e2e actually uses", () => {
    // The runner reads the directory, which is the right shape — but a spec
    // named outside its filter is a spec that never runs and never reports.
    const specDir = join(REPO, "tests/e2e");
    const files = readdirSync(specDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(name).toMatch(/\.spec\.mjs$/);
    expect(runner).toContain(".spec.mjs");
  });
});

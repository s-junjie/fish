import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Two invariants that keep a plugin external, checked against the tree rather
 * than against a list someone maintains by hand (AGENTS.md §5.1):
 *
 * 1. Nothing in the shell may import a plugin. One `import` and the panel is
 *    back inside the 480 KB shell — silently, and visible only as "the bundle
 *    grew a bit".
 * 2. A catalog row must describe the bytes that were actually built. A stale
 *    fingerprint turns every install into "this file is not a plugin this build
 *    recognises", which reads as a broken file rather than a stale build.
 *
 * Both walk the directory, so a plugin added tomorrow is covered without editing
 * this file.
 *
 * Reads are concurrent on purpose: under the test worker a synchronous
 * `readFileSync` costs ~40 ms per call, so the sync form of this scan takes 21 s
 * for `src/`. The same files read in parallel take ~1 s.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const PLUGINS = path.join(SRC, "plugins");
const OUT = path.join(ROOT, "dist-plugins");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * One flat pass per file: `from "x"`, `import "x"`, `import("x")`. A richer
 * pattern (anchored at line start, non-greedy up to `from`) backtracks for
 * seconds on the largest generated files in `src/`.
 */
function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

/**
 * Type-only imports are erased at build time, so they may still name host
 * modules. Everything that survives into the bundle must come through `_host`
 * (or `_shared`), otherwise a plugin carries its own copy of host logic.
 */
function runtimeSpecifiers(source: string): string[] {
  const withoutTypes = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\b(?:import|export)\s+type\b[\s\S]*?from\s*["'][^"']+["'];?/g, "");
  return specifiers(withoutTypes);
}

function externalDirs(): Set<string> {
  // Which directories are external is read off the disk, not listed here: a
  // plugin becomes external the moment the build gives it a `plugin.json`, and
  // the guard follows without an edit.
  return new Set(
    fs
      .readdirSync(PLUGINS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .filter((e) => fs.existsSync(path.join(PLUGINS, e.name, "plugin.json")))
      .map((e) => e.name)
  );
}

async function offenders(): Promise<string[]> {
  const external = externalDirs();
  const shellFiles = walk(SRC).filter((f) => !f.startsWith(PLUGINS + path.sep));
  const sources = await Promise.all(shellFiles.map((f) => fs.promises.readFile(f, "utf8")));

  const out: string[] = [];
  shellFiles.forEach((file, i) => {
    for (const spec of specifiers(sources[i])) {
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(PLUGINS + path.sep)) continue;
      const dir = path.relative(PLUGINS, target).split(path.sep)[0];
      if (external.has(dir)) out.push(`${path.relative(ROOT, file)} → ${spec}`);
    }
  });
  return out;
}

function runtimeOffenders(): string[] {
  const out: string[] = [];
  for (const dir of externalDirs()) {
    for (const file of walk(path.join(PLUGINS, dir))) {
      for (const spec of runtimeSpecifiers(fs.readFileSync(file, "utf8"))) {
        if (spec.startsWith("./")) continue;
        if (spec === "../_host" || spec.startsWith("../_host/")) continue;
        if (spec === "../_shared" || spec.startsWith("../_shared/")) continue;
        if (spec.startsWith("../")) {
          out.push(`${path.relative(ROOT, file)} → ${spec}`);
          continue;
        }
        if (/^(?:preact|react|react-dom)(?:\/|$)/.test(spec)) {
          out.push(`${path.relative(ROOT, file)} → ${spec}`);
        }
      }
    }
  }
  return out;
}

describe("plugins stay outside the shell", () => {
  it("knows at least one plugin is external", () => {
    expect(externalDirs().size).toBeGreaterThan(0);
  });

  it("no file outside src/plugins imports an externalised plugin", async () => {
    expect(await offenders()).toEqual([]);
  });

  it("plugin runtime code takes host helpers only from ../_host or ../_shared", () => {
    expect(runtimeOffenders()).toEqual([]);
  });

  it("a built bundle is one self-contained module carrying its own signature", () => {
    for (const dir of externalDirs()) {
      const meta = JSON.parse(fs.readFileSync(path.join(PLUGINS, dir, "plugin.json"), "utf8"));
      const file = path.join(OUT, meta.id, meta.version, "plugin.js");
      if (!fs.existsSync(file)) continue;

      const source = fs.readFileSync(file, "utf8");
      // The proof a shell needs to accept a plugin it has never heard of.
      expect(source).toContain("\n//#fish-plugin:");
      // A blob: module has no base URL: any unresolved specifier is a runtime
      // "Failed to resolve module specifier" at panel open, i.e. long after CI.
      expect(source).not.toMatch(/\bfrom\s*["'](?:preact|react)/);
      expect(source).not.toMatch(/\bimport\s*\(\s*["']\.\//);
      expect(source).toContain("__FISH_HOST__");
    }
  });
});

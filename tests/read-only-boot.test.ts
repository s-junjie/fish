// `docs/READONLY.md` R5 calls it "two locks, because one is a shell". The second
// one is invisible when it goes missing: the reader renders no editing surface
// either way, so the only symptom is a restored gesture or a plugin call reaching
// a document nobody may write. It is applied by every shell — which means it can
// be dropped by ADDING a shell — so this reads the shells instead of listing them.

import { readdirSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const roots = sourceFiles(path.join(SRC, "ui")).filter((file) => /Root\.tsx$/.test(file));

describe("read-only boot", () => {
  it("hands the store its lock in every shell", () => {
    expect(roots.length, "found no *Root.tsx to check — has the shell been renamed?").toBeGreaterThan(0);
    const unlocked = roots
      .filter((file) => !/useReadOnlyLock\(/.test(readFileSync(file, "utf-8")))
      .map((file) => path.relative(process.cwd(), file));
    expect(unlocked, "a shell mounts the store without R5's lock").toEqual([]);
  });

  it("keeps the entry free of state, so the mode is decided before any hook runs", () => {
    const entry = readFileSync(path.join(SRC, "main.tsx"), "utf-8");
    const calls = entry.match(/\buse[A-Z]\w*\s*\(/g) ?? [];
    expect(calls, "the entry decides the shell; assembly belongs to the shell").toEqual([]);
  });
});

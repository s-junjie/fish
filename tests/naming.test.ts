import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The layout mode is `grid`; the buzzword it gets called outside this repo is
 * not ours to use, so it must not creep back into authored content or the skill
 * documentation.
 */
const GUARDED = [
  "src/core/data-bridge.ts",
  "index.html",
  "AGENTS.md"
];

/**
 * The kit *is* the skill documentation. Read the directory instead of naming its
 * entry point, so a reference added or renamed under `agent-kit/` is guarded
 * without editing this list.
 */
const kitDocs = () =>
  fs
    .readdirSync(path.resolve(__dirname, "..", "agent-kit"), { recursive: true, encoding: "utf-8" })
    .filter((rel) => rel.endsWith(".md"))
    .map((rel) => `agent-kit/${rel}`)
    .sort();

describe("naming", () => {
  it("calls a grid a grid", () => {
    const offenders = [...GUARDED, ...kitDocs()].filter((rel) => {
      const file = path.resolve(__dirname, "..", rel);
      return fs.existsSync(file) && /bento/i.test(fs.readFileSync(file, "utf-8"));
    });
    expect(offenders).toEqual([]);
  });
});

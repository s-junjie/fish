import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assetsCommand } from "../src/core/cli/fish-assets";
import { check } from "../src/core/cli/fish-check";

/**
 * `assets prune` is the only command in the CLI that deletes bytes, so what it
 * must not do matters more than what it does: an asset that anything still names
 * — a paint, a poster, a style bound on a layer — has to survive, and a document
 * with nothing to prune has to be left byte-identical rather than rewritten.
 */

const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const documentWith = (assets: { id: string }[]): string =>
  JSON.stringify({
    version: "0.1",
    id: "d",
    name: "d",
    createdAt: "",
    updatedAt: "",
    canvas: { width: 100, height: 100 },
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas: { width: 100, height: 100 },
        children: [
          {
            id: "hero",
            type: "rect",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            fills: [{ type: "image", assetId: assets[0]?.id, fit: "cover" }]
          }
        ]
      }
    ],
    activePageId: "page_1",
    assets: assets.map((a) => ({ ...a, name: a.id, uri: DATA, width: 1, height: 1 }))
  });

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeDoc(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-prune-"));
  dirs.push(dir);
  const file = path.join(dir, "design.json");
  fs.writeFileSync(file, contents);
  return file;
}

const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});
const quietErr = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("fish assets prune", () => {
  it("drops the asset nothing paints and keeps the one that is", async () => {
    const file = writeDoc(documentWith([{ id: "asset_used" }, { id: "asset_orphan" }]));
    quiet();

    expect(await assetsCommand(["prune", file], { json: true })).toBe(0);

    const after = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(after.assets.map((a: { id: string }) => a.id)).toEqual(["asset_used"]);
  });

  it("reports the bytes it freed, so the rewrite is not a guess", async () => {
    const file = writeDoc(documentWith([{ id: "asset_used" }, { id: "asset_orphan" }]));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });

    await assetsCommand(["prune", file], { json: false });

    const out = logs.join("\n");
    expect(out).toContain("pruned 1 unreferenced asset(s): asset_orphan");
    expect(out).toContain("of embedded bytes freed");
    // The write re-serializes the document, so a before/after on the file can
    // read as "prune made it bigger" on a hand-formatted source.
    expect(out).not.toContain("document ");
  });

  it("leaves a clean document untouched and says there was nothing to do", async () => {
    const contents = documentWith([{ id: "asset_used" }]);
    const file = writeDoc(contents);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });

    await assetsCommand(["prune", file], { json: false });

    expect(fs.readFileSync(file, "utf-8")).toBe(contents);
    expect(logs.join("\n")).toContain("nothing to prune");
  });

  it("refuses without a document rather than guessing which one", async () => {
    quietErr();
    expect(await assetsCommand(["prune"], { json: false })).toBe(2);
  });

  it("is the number check already reports, so pruning is a decision and not a surprise", () => {
    const file = writeDoc(documentWith([{ id: "asset_used" }, { id: "asset_orphan" }]));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });

    expect(check(file, { json: false, strict: false, geometry: false, strictAssets: false, audit: false })).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("[info]");
    expect(out).toContain("painted nowhere");
    expect(out).toContain("asset_orphan");
    expect(out).toContain("fish assets prune");
  });
});

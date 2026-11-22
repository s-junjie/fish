import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brief, reconDocument } from "../src/core/cli/fish-brief";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * A system face is not a missing asset. `"PingFang SC, sans-serif"` says what a
 * machine without PingFang should do, and `fontDiagnostics` already treats that as
 * satisfied; brief used to say "export will not carry it" about it in the same
 * words it used for a webfont nobody embedded, which is the one state where the
 * sentence is true.
 */

const text = (id: string, fontFamily: string): DesignElement =>
  ({ id, type: "text", x: 0, y: 0, content: "x", style: { fontFamily, fontSize: 16 } } as unknown as DesignElement);

const doc = (fonts: { family: string; src?: string }[], elements: DesignElement[] = []): DesignDocument =>
  ({
    version: "0.1",
    id: "d",
    name: "d",
    createdAt: "",
    updatedAt: "",
    canvas: { width: 100, height: 100 },
    pages: [{ id: "page_1", name: "Page 1", canvas: { width: 100, height: 100 }, children: elements }],
    activePageId: "page_1",
    fonts
  } as unknown as DesignDocument);

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function briefLines(d: DesignDocument): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-brief-"));
  dirs.push(dir);
  const file = path.join(dir, "design.json");
  fs.writeFileSync(file, JSON.stringify(d));
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => {
    logs.push(String(line));
  });
  brief(file, { json: false });
  return logs.join("\n");
}

describe("reconDocument — what a font costs", () => {
  it("counts a family the document's own text declares a fallback for as covered", () => {
    const r = reconDocument(doc([{ family: "PingFang SC" }], [text("t", "PingFang SC, sans-serif")]));
    expect(r.fonts).toEqual([{ family: "PingFang SC", src: false, fallback: true }]);
  });

  it("does not cover a bare family, which is the claim the file cannot keep", () => {
    const r = reconDocument(doc([{ family: "Söhne" }], [text("t", "Söhne")]));
    expect(r.fonts).toEqual([{ family: "Söhne", src: false, fallback: false }]);
  });

  it("reads the fallback off the font entry itself when it carries one", () => {
    const r = reconDocument(doc([{ family: "Menlo, monospace" }]));
    expect(r.fonts[0].fallback).toBe(true);
  });

  it("says nothing about a font it actually carries", () => {
    const r = reconDocument(doc([{ family: "Inter", src: "https://example.test/inter.woff2" }]));
    expect(r.fonts[0]).toMatchObject({ src: true });
  });
});

describe("brief — one line, two different states", () => {
  it("names a declared substitution as the design, not as a gap", () => {
    const out = briefLines(doc([{ family: "PingFang SC" }], [text("t", "PingFang SC, sans-serif")]));
    expect(out).toContain("generic fallback declared");
    expect(out).not.toContain("will not carry it");
  });

  it("warns about the bare family that nothing embedded", () => {
    const out = briefLines(doc([{ family: "Söhne" }], [text("t", "Söhne")]));
    expect(out).toContain("no fallback");
    expect(out).toContain("re-wraps silently");
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import type { LocalFontsResult } from "../src/core/fonts/local-font-access";

// The permission prompt appears once per *call*, not once per document the user
// cares about, so the memo is the whole behaviour: two readers asking at the
// same time must still produce one call, and an answer already in hand — an
// empty list and a refusal included — must never be spent on a second prompt.
type Query = () => Promise<{ family: string; style: string }[]>;

async function freshModule(query?: Query) {
  vi.resetModules();
  (globalThis as unknown as { window?: unknown }).window =
    query === undefined ? {} : { queryLocalFonts: query };
  return await import("../src/core/fonts/local-font-access");
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.resetModules();
});

describe("readLocalFonts", () => {
  it("answers two concurrent readers with one call", async () => {
    let calls = 0;
    const { readLocalFonts } = await freshModule(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return [{ family: "Arial", style: "Regular" }];
    });
    const [a, b] = await Promise.all([readLocalFonts(), readLocalFonts()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("derives a sorted, deduplicated family list from the faces", async () => {
    const { readLocalFonts } = await freshModule(async () => [
      { family: "Arial", style: "Regular" },
      { family: "Arial", style: "Bold" },
      { family: "Zapf Dingbats", style: "Regular" },
      { family: " ", style: "Regular" }
    ]);
    const res = await readLocalFonts();
    expect(res.ok && res.families).toEqual(["Arial", "Zapf Dingbats"]);
  });

  it("caches a refusal instead of asking again, and says why", async () => {
    let calls = 0;
    const { readLocalFonts } = await freshModule(async () => {
      calls++;
      throw new Error("denied");
    });
    const first = await readLocalFonts();
    const second = await readLocalFonts();
    expect(calls).toBe(1);
    expect(first).toEqual<LocalFontsResult>({ ok: false, reason: "denied" });
    expect(second).toBe(first);
  });

  it("treats an empty list as an answer, not as a refusal", async () => {
    const { readLocalFonts } = await freshModule(async () => []);
    const res = await readLocalFonts();
    expect(res.ok).toBe(true);
    expect(res.ok && res.faces).toEqual([]);
  });

  it("reports a missing API without calling anything", async () => {
    const { readLocalFonts, supportsLocalFonts } = await freshModule();
    const res = await readLocalFonts();
    expect(supportsLocalFonts()).toBe(false);
    expect(res).toEqual<LocalFontsResult>({ ok: false, reason: "no-api" });
  });

  it("knows whether an answer is already in hand, without reading it", async () => {
    let calls = 0;
    const { hasLocalFonts, readLocalFonts } = await freshModule(async () => {
      calls++;
      return [];
    });
    expect(hasLocalFonts()).toBe(false);
    await readLocalFonts();
    expect(hasLocalFonts()).toBe(true);
    expect(calls).toBe(1);
  });
});
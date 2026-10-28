import { describe, expect, it } from "vitest";
import { claimAuthoredId, minterFor } from "../src/core/import/html-ids";

/**
 * An element's HTML `id` becomes its element id, which is what `fish assets
 * import --to` and a `patch` target read. These are the three answers the walk
 * can get back, and the minter that consumes them.
 */

describe("claimAuthoredId", () => {
  it("takes the page's id as written", () => {
    expect(claimAuthoredId("hero_img", new Set())).toEqual({ id: "hero_img" });
  });

  it("treats a missing or blank id as none at all", () => {
    expect(claimAuthoredId(null, new Set())).toBeNull();
    expect(claimAuthoredId("   ", new Set())).toBeNull();
  });

  it("reserves the id so a second element cannot take it", () => {
    const taken = new Set<string>();
    expect(claimAuthoredId("card", taken)).toEqual({ id: "card" });
    expect(claimAuthoredId("card", taken)).toEqual({ conflict: "card" });
  });

  it("reports an id the document already owns instead of renaming it", () => {
    const taken = new Set(["hero"]);
    expect(claimAuthoredId("hero", taken)).toEqual({ conflict: "hero" });
    expect([...taken]).toEqual(["hero"]);
  });

  it("folds characters an id cannot carry, and says what it was", () => {
    expect(claimAuthoredId("hero.img", new Set())).toEqual({ id: "hero_img", renamedFrom: "hero.img" });
  });
});

describe("minterFor", () => {
  it("gives the authored id to the element's own box", () => {
    expect(minterFor("cta")("frame")).toBe("cta");
  });

  it("mints for every box synthesized out of the same element", () => {
    const mint = minterFor("cta");
    mint("frame");
    expect(mint("text")).toMatch(/^text_/);
  });

  it("mints unconditionally when the page wrote no id", () => {
    const mint = minterFor(null);
    expect(mint("rect")).toMatch(/^rect_/);
    expect(mint("rect")).not.toBe(mint("rect"));
  });
});

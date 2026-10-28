import { describe, expect, it } from "vitest";
import { canonicalKey } from "../src/core/dsl/normalize/shared";

/**
 * `canonicalKey` is the shared canonicaliser for keys AND values, so widening it
 * to split camelCase is a contract change with a value side as well as a key
 * side. `alignItems` reaching `align-items` is the key half, `scaleDown`
 * reaching `scale-down` is the value half, and an acronym run must survive.
 */
describe("canonicalKey — the shared key/value canonicaliser", () => {
  it("splits a camelCase boundary into kebab", () => {
    expect(canonicalKey("alignItems")).toBe("align-items");
    expect(canonicalKey("flexDirection")).toBe("flex-direction");
    expect(canonicalKey("justifyContent")).toBe("justify-content");
    expect(canonicalKey("scaleDown")).toBe("scale-down");
    expect(canonicalKey("colorDodge")).toBe("color-dodge");
  });

  it("collapses spaces and underscores the way it always did", () => {
    expect(canonicalKey("hero_image")).toBe("hero-image");
    expect(canonicalKey("Hero Image")).toBe("hero-image");
    expect(canonicalKey(" Pass Through ")).toBe("pass-through");
  });

  it("leaves an acronym run intact (no interior lower→upper boundary)", () => {
    expect(canonicalKey("OKLCH")).toBe("oklch");
    expect(canonicalKey("RGB")).toBe("rgb");
  });
});

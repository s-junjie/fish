import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";

describe("Document dialect", () => {
  it("keeps a declared version as normalization found it", () => {
    expect(normalizeDesignDocument({ version: "0.1", elements: [] }).document.version).toBe("0.1");
  });

  it("defaults missing or invalid version to the current dialect with a repair", () => {
    expect(normalizeDesignDocument({ elements: [] }).document.version).toBe(LATEST_DOCUMENT_VERSION);

    const invalid = normalizeDesignDocument({ version: 123, elements: [] });
    expect(invalid.document.version).toBe(LATEST_DOCUMENT_VERSION);
    expect(invalid.repairs.some((r) => r.path === "/version")).toBe(true);
  });

  it("leaves an unrecognised version alone rather than relabelling it", () => {
    const res = normalizeDesignDocument({ version: "9.9", elements: [] });
    expect(res.document.version).toBe("9.9");
  });
});

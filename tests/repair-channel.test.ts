import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";

function docWithElement(extra: Record<string, unknown>) {
  return {
    pages: [
      {
        id: "p1",
        name: "Page 1",
        children: [
          { id: "el1", type: "rect", name: "r", x: 0, y: 0, width: 10, height: 10, ...extra }
        ]
      }
    ],
    activePageId: "p1"
  };
}

describe("repair channel", () => {
  it("reports a key the engine does not read", () => {
    const result = normalizeDesignDocument(docWithElement({ nonsenseKey: "center" }));
    const hits = result.repairs.filter((r) => r.message.includes("nonsenseKey"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].kind).toBe("dropped-property");
    expect(hits[0].path).toContain("nonsenseKey");
  });

  it("drops the value rather than keeping it silently", () => {
    const result = normalizeDesignDocument(docWithElement({ nonsenseKey: "center" }));
    expect((result.document.pages?.[0]?.children?.[0] as any)?.nonsenseKey).toBeUndefined();
  });

  it("absorbs the CSS `alignSelf` spelling rather than dropping it (P0.5)", () => {
    // The repair-channel guarantee moved to a genuinely unknown key above; the
    // CSS name an author writes is now accepted and stored under the flat key.
    const result = normalizeDesignDocument(docWithElement({ alignSelf: "center" }));
    expect((result.document.pages?.[0]?.children?.[0] as any)?.["align-self"]).toBe("center");
    expect(result.repairs.find((r) => r.kind === "dropped-property" && r.message.includes("alignSelf"))).toBeUndefined();
  });

  it("reports a top-level layout key with no display", () => {
    // With no `display` there is no layout to hold it, so the flat key is named
    // back rather than silently creating a flex box.
    const result = normalizeDesignDocument(docWithElement({ padding: 16 }));
    const hit = result.repairs.find((r) => r.message.includes("padding"));
    expect(hit?.kind).toBe("dropped-property");
    expect(hit?.message).toContain("needs a layout");
  });

  it("reports `wrap` when there is no layout, instead of a silent no-op", () => {
    // `wrap` is a known key to the normalizer, so it never reached the "unknown
    // property" path above — and nothing read it either. A document that wrote
    // it saved, loaded, and simply did not wrap, with an empty repair list that
    // was indistinguishable from success. It is read as `flex-wrap` when a
    // layout is there, and says where it belongs when one is not.
    const result = normalizeDesignDocument(docWithElement({ wrap: "wrap" }));
    const hit = result.repairs.find((r) => r.message.includes("wrap"));
    expect(hit?.kind).toBe("dropped-property");
    expect(hit?.message).toContain("flex-wrap");
  });
});

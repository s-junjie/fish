import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { normalizeLink } from "../src/core/dsl/link";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import versions from "../src/core/dsl/versions.json";
import type { DesignElement } from "../src/core/dsl/types";

const doc = (element: Record<string, unknown>) =>
  ({
    version: versions.current,
    canvas: { width: 100, height: 100, unit: "px" },
    elements: [{ id: "e", type: "rect", x: 0, y: 0, width: 10, height: 10, ...element }]
  }) as never;

const loadFirst = (element: Record<string, unknown>) => {
  const { document, repairs } = normalizeDesignDocument(doc(element), { preserveUnknown: true });
  return { el: getActivePage(document).children[0] as DesignElement | undefined, repairs };
};

describe("normalizeLink keeps only what is safe to open", () => {
  it("accepts the four schemes a layer may point at", () => {
    expect(normalizeLink("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeLink("http://example.com")).toBe("http://example.com/");
    expect(normalizeLink("mailto:hi@example.com")).toBe("mailto:hi@example.com");
    expect(normalizeLink("tel:+8613800000000")).toBe("tel:+8613800000000");
  });

  it("reads a bare host as https, because that is what a person types", () => {
    expect(normalizeLink("example.com/pricing")).toBe("https://example.com/pricing");
    expect(normalizeLink("  example.com  ")).toBe("https://example.com/");
  });

  it("refuses a scheme that must never reach window.open", () => {
    // The one refusal that is a security boundary rather than a typo.
    expect(normalizeLink("javascript:alert(1)")).toBeUndefined();
    expect(normalizeLink("data:text/html,<script>1</script>")).toBeUndefined();
    expect(normalizeLink("file:///etc/passwd")).toBeUndefined();
  });

  it("refuses what is not a URL at all", () => {
    expect(normalizeLink("")).toBeUndefined();
    expect(normalizeLink("   ")).toBeUndefined();
    expect(normalizeLink("not a link")).toBeUndefined();
    expect(normalizeLink("#section")).toBeUndefined();
    expect(normalizeLink(42)).toBeUndefined();
    expect(normalizeLink(null)).toBeUndefined();
  });
});

describe("an element's link survives a load", () => {
  it("keeps the canonical key", () => {
    const { el } = loadFirst({ link: "https://example.com/x" });
    expect(el?.link).toBe("https://example.com/x");
  });

  it("absorbs the alias spellings rather than dropping them", () => {
    for (const alias of ["href", "linkUrl"]) {
      const { el } = loadFirst({ [alias]: "example.com" });
      expect(el?.link, alias).toBe("https://example.com/");
      // The alias itself must not ride along: two keys meaning one thing is how
      // a document ends up disagreeing with itself.
      expect((el as unknown as Record<string, unknown>)[alias], alias).toBeUndefined();
    }
  });

  it("reports a refused link instead of dropping it in silence", () => {
    const { el, repairs } = loadFirst({ link: "javascript:alert(1)" });
    expect(el?.link).toBeUndefined();
    expect(repairs.some((r) => r.path === "/elements/0/link")).toBe(true);
  });

  it("treats an empty link as no link, with nothing to report", () => {
    const { el, repairs } = loadFirst({ link: "   " });
    expect(el?.link).toBeUndefined();
    expect(repairs.filter((r) => r.path === "/elements/0/link")).toEqual([]);
  });
});

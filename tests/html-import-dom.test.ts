import { afterEach, describe, expect, it } from "vitest";
import { ruleMatches } from "../src/core/import/html-dom";

/**
 * `@media` and `@supports` both carry a `conditionText`, so reading the
 * property cannot tell them apart — and the two need opposite APIs.
 * `CSS.supports()` asks "does the UA understand this condition"; `matchMedia`
 * asks "does it match the window". Handing a media query to `CSS.supports`
 * admits rules the browser never applied (`(max-width: 600px)` reads as
 * supported at any width), and a query it cannot parse throws, which aborts the
 * scan of the whole sheet. Since `authored()` is where a grid's `fr` ratios come
 * from, either failure silently costs the ratio with nothing recorded.
 */
const RULE_MEDIA = 4;
const RULE_SUPPORTS = 12;
const RULE_CONTAINER = 13;

const stub = (ruleType: number, condition = "") => {
  const asked: string[] = [];
  const g = globalThis as unknown as {
    window: { matchMedia: (c: string) => { matches: boolean } };
    CSS: { supports: (c: string) => boolean };
  };
  const savedWindow = (globalThis as { window?: unknown }).window;
  const savedCSS = (globalThis as { CSS?: unknown }).CSS;
  g.window = {
    matchMedia: (c: string) => {
      asked.push(`media:${c}`);
      return { matches: true };
    }
  };
  g.CSS = {
    supports: (c: string) => {
      asked.push(`supports:${c}`);
      return true;
    }
  };
  return {
    asked,
    // A real CSSMediaRule and CSSSupportsRule BOTH carry `conditionText`, which
    // is exactly why the property cannot be used to tell them apart.
    rule: { type: ruleType, conditionText: condition } as unknown as CSSRule,
    restore: () => {
      if (savedWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else g.window = savedWindow as typeof g.window;
      if (savedCSS === undefined) delete (globalThis as { CSS?: unknown }).CSS;
      else g.CSS = savedCSS as typeof g.CSS;
    }
  };
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { CSS?: unknown }).CSS;
});

describe("ruleMatches", () => {
  it("asks the window about a media query, not the UA about support for it", () => {
    const s = stub(RULE_MEDIA, "(max-width: 600px)");
    try {
      expect(ruleMatches(s.rule, "(max-width: 600px)")).toBe(true);
      expect(s.asked).toEqual(["media:(max-width: 600px)"]);
    } finally {
      s.restore();
    }
  });

  it("asks about support for a supports condition", () => {
    const s = stub(RULE_SUPPORTS, "display: grid");
    try {
      expect(ruleMatches(s.rule, "display: grid")).toBe(true);
      expect(s.asked).toEqual(["supports:display: grid"]);
    } finally {
      s.restore();
    }
  });

  it("takes a group it cannot evaluate as in force rather than dropping it", () => {
    const s = stub(RULE_CONTAINER, "(min-width: 400px)");
    try {
      expect(ruleMatches(s.rule, "(min-width: 400px)")).toBe(true);
      expect(s.asked).toEqual([]);
    } finally {
      s.restore();
    }
  });

  it("reports an unparseable condition as not matching, the way the browser did", () => {
    const s = stub(RULE_MEDIA, "not a query");
    try {
      (globalThis as unknown as { window: { matchMedia: () => never } }).window.matchMedia = () => {
        throw new SyntaxError("bad query");
      };
      expect(ruleMatches(s.rule, "not a query")).toBe(false);
    } finally {
      s.restore();
    }
  });
});

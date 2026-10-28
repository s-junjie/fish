import { describe, expect, it } from "vitest";
import {
  DARK_MODE,
  categoryFor,
  createHtmlTokens,
  customPropertiesOf,
  tokenNameOf,
  type CustomPropertyTable
} from "../src/core/import/html-tokens";
import type { ColorToken, NumberToken } from "../src/core/dsl/types";

/** A stand-in for one stylesheet rule: only the three members the scan reads. */
function rule(selectorText: string, declarations: Record<string, string>) {
  const style: Record<string, unknown> = {
    getPropertyValue: (name: string) => declarations[name] ?? ""
  };
  Object.keys(declarations).forEach((name, i) => {
    style[String(i)] = name;
  });
  style.length = Object.keys(declarations).length;
  return { selectorText, style } as unknown as CSSStyleRule;
}

function media(conditionText: string, rules: unknown[]) {
  return { conditionText, cssRules: rules } as unknown as CSSMediaRule;
}

const shadow = (...sheets: unknown[][]) =>
  ({ styleSheets: sheets.map((cssRules) => ({ cssRules })) }) as unknown as ShadowRoot;

const table = (entries: Record<string, { base?: string; dark?: string }>): CustomPropertyTable =>
  new Map(Object.entries(entries));

describe("tokenNameOf", () => {
  it("turns the first hyphen into the group the token list files it under", () => {
    expect(tokenNameOf("--brand-primary")).toBe("brand/primary");
    expect(tokenNameOf("--space-md")).toBe("space/md");
  });

  it("leaves a name with no group alone", () => {
    expect(tokenNameOf("--radius")).toBe("radius");
    expect(tokenNameOf("--panel")).toBe("panel");
  });
});

describe("customPropertiesOf", () => {
  it("reads a property the page declared at document scope", () => {
    const found = customPropertiesOf(shadow([rule(":host", { "--panel": "#FFFFFF" })]));
    expect(found.get("--panel")).toEqual({ base: "#FFFFFF" });
  });

  it("files a `prefers-color-scheme` block under dark", () => {
    const found = customPropertiesOf(
      shadow([
        rule(":root", { "--panel": "#FFFFFF" }),
        media("(prefers-color-scheme: dark)", [rule(":root", { "--panel": "#000000" })])
      ])
    );
    expect(found.get("--panel")).toEqual({ base: "#FFFFFF", dark: "#000000" });
  });

  it("reads the `.dark` scope a Tailwind page writes its dark values in", () => {
    const found = customPropertiesOf(shadow([rule(".dark", { "--panel": "#000000" })]));
    expect(found.get("--panel")).toEqual({ dark: "#000000" });
  });

  it("leaves a property scoped to one selector out — the element's cascade owns it", () => {
    const found = customPropertiesOf(shadow([rule(".card", { "--card-bg": "#101010" })]));
    expect(found.has("--card-bg")).toBe(false);
  });

  it("keeps going past a sheet whose rules cannot be read", () => {
    const unreadable = {
      get cssRules(): CSSRuleList {
        throw new Error("cross-origin");
      }
    };
    const found = customPropertiesOf(
      ({ styleSheets: [unreadable, { cssRules: [rule(":host", { "--ink": "#111111" })] }] } as unknown as ShadowRoot)
    );
    expect(found.get("--ink")).toEqual({ base: "#111111" });
  });

  it("lets a later declaration win, which is what the cascade does", () => {
    const found = customPropertiesOf(
      shadow([rule(":host", { "--ink": "#111111" }), rule("html", { "--ink": "#222222" })])
    );
    expect(found.get("--ink")?.base).toBe("#222222");
  });
});

describe("createHtmlTokens", () => {
  it("mints a colour token the first time a property references one", () => {
    const tokens = createHtmlTokens(table({ "--brand-primary": { base: "#2563EB" } }));
    const lookup = tokens.lookup((property) => (property === "background-color" ? "var(--brand-primary)" : undefined));

    const id = lookup.color("background-color", "#2563EB");
    expect(tokens.tokens).toHaveLength(1);
    const token = tokens.tokens[0] as ColorToken;
    expect(token.id).toBe(id);
    expect(token.name).toBe("brand/primary");
    expect(token.value).toBe("#2563EB");
  });

  it("mints nothing for a property the page did not write as a var", () => {
    const tokens = createHtmlTokens(table({ "--brand-primary": { base: "#2563EB" } }));
    const lookup = tokens.lookup(() => "#2563EB");
    expect(lookup.color("background-color", "#2563EB")).toBeUndefined();
    expect(tokens.tokens).toHaveLength(0);
  });

  it("names the token without minting it, so a four-sided border asks for free", () => {
    const tokens = createHtmlTokens(table({ "--line": { base: "#E5E7EB" } }));
    const lookup = tokens.lookup((property) => (property === "border-top-color" ? "var(--line)" : undefined));
    expect(lookup.name(["border-color", "border-top-color"])).toBe("--line");
    expect(tokens.tokens).toHaveLength(0);
  });

  it("mints one token for a property no declaration backs, because the computed value proves it exists", () => {
    const tokens = createHtmlTokens(table({}));
    const lookup = tokens.lookup((property) => (property === "color" ? "var(--ghost)" : undefined));
    const id = lookup.color("color", "#334155");
    expect(id).toBeDefined();
    expect(tokens.tokens[0]).toMatchObject({ name: "ghost", type: "color", value: "#334155" });
  });

  it("reads a property scoped to the element out of its own cascade", () => {
    const tokens = createHtmlTokens(table({}));
    const lookup = tokens.lookup((property) =>
      property === "background-color" ? "var(--card-bg)" : property === "--card-bg" ? "#101010" : undefined
    );
    expect(lookup.color("background-color", "#101010")).toBeDefined();
    expect(tokens.tokens[0]).toMatchObject({ name: "card/bg" });
  });

  it("files the dark declaration as a mode and keeps the light value as the base", () => {
    const tokens = createHtmlTokens(table({ "--panel": { base: "#FFFFFF", dark: "#0A0A0A" } }));
    const lookup = tokens.lookup(() => "var(--panel)");
    lookup.color("background-color", "#FFFFFF");

    const token = tokens.tokens[0] as ColorToken;
    expect(token.value).toBe("#FFFFFF");
    expect(token.modes?.[DARK_MODE.id]).toBe("#0A0A0A");
    expect(tokens.modes).toEqual([{ id: "dark", name: "Dark" }]);
  });

  /**
   * `prefers-color-scheme` is the BROWSER's, so a page with a dark block may be
   * measured in the dark: the computed value is the dark one, and the token's
   * base has to come from the light declaration or "light" would hold #0A0A0A.
   */
  it("takes the base from the light declaration when the page was measured in its dark scheme", () => {
    const tokens = createHtmlTokens(table({ "--panel": { base: "#FFFFFF", dark: "#0A0A0A" } }));
    const lookup = tokens.lookup((property) => (property === "background-color" ? "var(--panel)" : undefined));
    lookup.color("background-color", "#0A0A0A");

    const token = tokens.tokens[0] as ColorToken;
    expect(token.value).toBe("#FFFFFF");
    expect(token.modes?.[DARK_MODE.id]).toBe("#0A0A0A");
  });

  it("reports no mode when the page declared none", () => {
    const tokens = createHtmlTokens(table({ "--panel": { base: "#FFFFFF" } }));
    tokens.lookup(() => "var(--panel)").color("background-color", "#FFFFFF");
    expect(tokens.modes).toEqual([]);
  });

  it("refuses a dark value written in a unit it cannot resolve, rather than guessing one", () => {
    const tokens = createHtmlTokens(table({ "--space-md": { base: "16px", dark: "1.5rem" } }));
    tokens.lookup(() => "var(--space-md)").number("gap", 16);
    const token = tokens.tokens[0] as NumberToken;
    expect(token.value).toBe(16);
    expect(token.modes).toBeUndefined();
  });

  it("mints a number token with the category the property decides", () => {
    const tokens = createHtmlTokens(table({ "--r-md": { base: "10px" } }));
    const lookup = tokens.lookup(() => "var(--r-md)");
    const id = lookup.number("border-radius", 10);

    const token = tokens.tokens[0] as NumberToken;
    expect(token.id).toBe(id);
    expect(token.type).toBe("number");
    expect(token.category).toBe("radius");
    expect(token.value).toBe(10);
  });

  it("reuses the document's own token instead of duplicating it on a second import", () => {
    const existing: ColorToken = {
      id: "tok_existing",
      name: "brand/primary",
      type: "color",
      value: "#2563EB"
    };
    const tokens = createHtmlTokens(table({ "--brand-primary": { base: "#2563EB" } }), { tokens: [existing] });
    const lookup = tokens.lookup(() => "var(--brand-primary)");

    expect(lookup.color("background-color", "#2563EB")).toBe("tok_existing");
    expect(tokens.tokens).toHaveLength(0);
  });

  it("does not reuse a same-named token that holds a different colour", () => {
    const existing: ColorToken = {
      id: "tok_existing",
      name: "brand/primary",
      type: "color",
      value: "#DC2626"
    };
    const tokens = createHtmlTokens(table({ "--brand-primary": { base: "#2563EB" } }), { tokens: [existing] });
    const id = tokens.lookup(() => "var(--brand-primary)").color("background-color", "#2563EB");
    expect(id).not.toBe("tok_existing");
    expect(tokens.tokens).toHaveLength(1);
  });

  it("binds every property that names the same token to one token, and counts each", () => {
    const tokens = createHtmlTokens(table({ "--panel": { base: "#FFFFFF" } }));
    const lookup = tokens.lookup(() => "var(--panel)");
    const first = lookup.color("background-color", "#FFFFFF");
    const second = lookup.color("color", "#FFFFFF");
    expect(first).toBe(second);
    expect(tokens.tokens).toHaveLength(1);
    expect(tokens.bound).toBe(2);
  });
});

describe("categoryFor", () => {
  it("lets the property decide before the name", () => {
    expect(categoryFor("border-radius", "--md")).toBe("radius");
    expect(categoryFor("font-size", "--md")).toBe("typography");
    expect(categoryFor("letter-spacing", "--tight")).toBe("typography");
    expect(categoryFor("gap", "--md")).toBe("spacing");
    expect(categoryFor("border-top-width", "--hairline")).toBe("stroke");
  });

  it("falls back to the name for a property it cannot place", () => {
    expect(categoryFor("width", "--space-md")).toBe("spacing");
    expect(categoryFor("width", "--radius-lg")).toBe("radius");
    expect(categoryFor("width", "--card-shadow-blur")).toBe("effect");
    expect(categoryFor("width", "--shell")).toBe("size");
  });
});

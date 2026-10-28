/**
 * CSS custom properties → FISH design tokens.
 *
 * An HTML import reads COMPUTED style, and computed style has already folded
 * every `var(--x)` into the literal it stood for — which is exactly what the
 * importer needs to draw the page, and exactly what makes the page's own token
 * system invisible to it. The names survive in exactly one place: the
 * declarations, on the sheets the mount owns. This reads them back and mints one
 * FISH token per referenced custom property, so a page authored against
 * `--brand-primary` arrives bound rather than as a hex that happens to match.
 *
 * A token's value is materialised from the COMPUTED value, never from the
 * declaration: a declaration may be written in a colour space or a unit this
 * importer does not parse, and the computed value is what the page rendered.
 * The declaration is read for one thing only — the value the OTHER mode uses.
 */

import type {
  ColorToken,
  DesignStyle,
  DesignToken,
  DocumentMode,
  NumberToken,
  NumberTokenCategory
} from "../dsl/types";
import { createNumberToken } from "../interactions/number-token-ops";
import { createColorToken } from "../interactions/token-ops";
import { composeColorAlpha } from "../geometry/color-utils";
import { absolutePx, parseCssColor } from "./css-values";

/** The mode an imported page's dark declarations are filed under. */
export const DARK_MODE: DocumentMode = { id: "dark", name: "Dark" };

/** What the page declared for one custom property. */
export interface CustomProperty {
  /** The value in force at the mode the page was measured in. */
  base?: string;
  /** The value a dark context declares for the same property. */
  dark?: string;
}

/** `--name` → what the page declared for it. */
export type CustomPropertyTable = Map<string, CustomProperty>;

/** The author's declaration for a property, as the mount reads it. */
export type AuthoredLookup = (property: string) => string | undefined;

/**
 * The token a property binds to, asked for one property at a time.
 *
 * A property may be named more than once because CSS authors rarely write the
 * longhand an importer has to read: `border: 1px solid var(--line)` leaves
 * `border-color` empty in Chrome while `border-top-color` answers, and the
 * reverse happens for a one-side rule.
 */
export interface TokenLookup {
  /**
   * The custom property an authored value names, minting nothing.
   *
   * Separate from the two below because a stroke is four sides: asking whether
   * every drawn side names the SAME property has to be free, or a four-sided
   * border would mint four tokens to answer one question.
   */
  name: (property: string | readonly string[]) => string | undefined;
  color: (property: string | readonly string[], computed: string) => string | undefined;
  number: (property: string | readonly string[], computed: number) => string | undefined;
}

const GLOBAL_SCOPE = /^(?::host\b|:host\(|:root\b|html\b|body\b|\*)/;
const DARK_MEDIA = /prefers-color-scheme\s*:\s*dark/i;
const VAR_RE = /var\(\s*(--[\w-]+)/;

/** A selector whose own text says it is the dark-mode scope. */
const isDarkScope = (selector: string): boolean => /dark/i.test(selector) && !/light/i.test(selector);

function varNameOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = VAR_RE.exec(raw);
  return match ? match[1] : undefined;
}

/**
 * `--brand-primary` → `brand/primary`.
 *
 * The first hyphen becomes the group the token list files it under and the rest
 * stays as written, which is how the page's own prefixes (`color-`, `space-`,
 * `radius-`) read to the designer who wrote them.
 */
export function tokenNameOf(cssName: string): string {
  const raw = cssName.replace(/^--/, "").trim();
  const at = raw.indexOf("-");
  if (at <= 0 || at === raw.length - 1) return raw || "token";
  return `${raw.slice(0, at)}/${raw.slice(at + 1)}`;
}

/**
 * Every custom property the page declares at a scope that applies to the whole
 * document.
 *
 * A property declared on one selector (`.card { --card-bg }`) is deliberately
 * left out: it is not a document-level token, and the element's own cascade is
 * the only thing that can say which of several it inherits. That case is read
 * per element instead, through the same `authored` lookup the walk already uses.
 */
export function customPropertiesOf(shadow: ShadowRoot): CustomPropertyTable {
  const table: CustomPropertyTable = new Map();
  for (const sheet of Array.from(shadow.styleSheets ?? [])) {
    // A cross-origin sheet throws on `cssRules`. Unreadable, not absent: the
    // sheets after it still carry tokens.
    try {
      visitRules(sheet.cssRules, false, table);
    } catch {
      continue;
    }
  }
  return table;
}

function visitRules(rules: CSSRuleList | undefined, dark: boolean, table: CustomPropertyTable): void {
  if (!rules || typeof rules.length !== "number") return;
  for (const rule of Array.from(rules)) {
    const selectorText = (rule as CSSStyleRule).selectorText;
    if (typeof selectorText === "string") {
      const scopes = selectorText
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const global = scopes.some((part) => GLOBAL_SCOPE.test(part));
      const scoped = scopes.some(isDarkScope);
      if (!global && !scoped) continue;
      writeDeclarations((rule as CSSStyleRule).style, table, dark || scoped);
      continue;
    }
    const nested = (rule as CSSGroupingRule).cssRules;
    if (!nested || typeof nested.length !== "number") continue;
    const condition = (rule as CSSConditionRule).conditionText;
    // `@supports` and `@layer` inherit the mode they sit in; a
    // `prefers-color-scheme` query starts a dark one for everything inside it.
    visitRules(nested, dark || (typeof condition === "string" && DARK_MEDIA.test(condition)), table);
  }
}

function writeDeclarations(
  style: CSSStyleDeclaration | undefined,
  table: CustomPropertyTable,
  dark: boolean
): void {
  if (!style || typeof style.length !== "number") return;
  for (let i = 0; i < style.length; i += 1) {
    const name = style[i];
    if (typeof name !== "string" || !name.startsWith("--")) continue;
    const value = style.getPropertyValue(name).trim();
    if (!value) continue;
    // Later rules win, which is what the cascade does to two declarations of
    // the same weight.
    const entry = table.get(name) ?? {};
    if (dark) entry.dark = value;
    else entry.base = value;
    table.set(name, entry);
  }
}

/**
 * A declared length, in px.
 *
 * `rem`, `em`, `%` and `calc()` are refused rather than approximated: they
 * resolve against a box or a font the importer does not carry, and a dark-mode
 * value guessed from an assumed root size is a token that lies.
 */
function declaredLength(raw: string): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const absolute = absolutePx(value);
  if (absolute !== undefined) return absolute;
  return /^-?\d*\.?\d+$/.test(value) ? Number(value) : undefined;
}

/** A colour token whose stored hex, alpha included, is `hex`. */
function isColorTokenWith(token: DesignToken, hex: string): token is ColorToken {
  return token.type === "color" && token.value === hex;
}

/** A CSS colour as one token value: the hex, with any alpha folded into it. */
function tokenHex(color: { color: string; opacity?: number }): string {
  const hex6 = color.color.slice(0, 7);
  return typeof color.opacity === "number" && color.opacity < 1
    ? composeColorAlpha(hex6, Math.round(color.opacity * 100))
    : color.color;
}

export interface HtmlTokensOptions {
  /**
   * The document's own tokens, so importing the same page twice reuses the
   * tokens it produced the first time instead of duplicating them.
   */
  tokens?: readonly DesignToken[];
}

export interface HtmlTokens {
  /** Every colour and number token minted during the walk, in first-reference order. */
  readonly tokens: DesignToken[];
  /** COLOUR modes the page declared beyond the base one. Empty when it declared none. */
  readonly modes: DocumentMode[];
  /** NUMBER modes it declared beyond the base one — a separate axis, separately empty. */
  readonly numberModes: DocumentMode[];
  /** How many element properties were bound to a token. */
  readonly bound: number;
  /** A lookup bound to one element, which is what can read a scoped property. */
  lookup: (authored: AuthoredLookup) => TokenLookup;
}

export function createHtmlTokens(table: CustomPropertyTable, options: HtmlTokensOptions = {}): HtmlTokens {
  const minted: DesignToken[] = [];
  const byName = new Map<string, DesignToken>();
  // Two flags, because a page's `prefers-color-scheme` block is a colour fact and
  // a number token filed under `dark` needs the number axis to name it.
  let usedDarkColor = false;
  let usedDarkNumber = false;
  let bound = 0;

  /** The declaration for one property, from the element's cascade or the table. */
  const declarationsFor = (cssName: string, authored: AuthoredLookup): CustomProperty => {
    const scoped = authored(cssName);
    // An alias (`--card-bg: var(--panel)`) names no value of its own, so it is
    // left to the table and, failing that, to the computed value.
    if (scoped && !VAR_RE.test(scoped)) return { base: scoped, dark: table.get(cssName)?.dark };
    return table.get(cssName) ?? {};
  };

  const reuse = (cssName: string, matches: (token: DesignToken) => boolean): DesignToken | undefined => {
    for (const token of options.tokens ?? []) {
      if (token.name === tokenNameOf(cssName) && matches(token)) return token;
    }
    return undefined;
  };

  const colorToken = (cssName: string, computed: string, declared: CustomProperty): string => {
    const known = byName.get(cssName);
    if (known) {
      bound += 1;
      return known.id;
    }
    const dark = declared.dark ? parseCssColor(declared.dark) : undefined;
    /* `prefers-color-scheme` is the BROWSER's, and an import cannot pick one —
       a page with a dark block was measured in whichever the machine is set to.
       A computed value equal to the dark declaration says which, and the token's
       base value then has to come from the light one, or the mode that ships as
       the default would hold the dark colour. */
    const base =
      dark && dark.color === computed && declared.base
        ? parseCssColor(declared.base)?.color ?? computed
        : computed;

    const existing = reuse(cssName, (entry) => isColorTokenWith(entry, base));
    if (existing) {
      byName.set(cssName, existing);
      bound += 1;
      return existing.id;
    }

    const token = createColorToken(tokenNameOf(cssName), base);
    if (dark) {
      token.modes = { [DARK_MODE.id]: tokenHex(dark) };
      usedDarkColor = true;
    }
    minted.push(token);
    byName.set(cssName, token);
    bound += 1;
    return token.id;
  };

  const numberToken = (
    cssName: string,
    computed: number,
    declared: CustomProperty,
    category: NumberTokenCategory
  ): string => {
    const known = byName.get(cssName);
    if (known) {
      bound += 1;
      return known.id;
    }
    const dark = declared.dark ? declaredLength(declared.dark) : undefined;
    const base =
      dark !== undefined && Math.abs(dark - computed) < 0.01 && declared.base
        ? declaredLength(declared.base) ?? computed
        : computed;

    const existing = reuse(
      cssName,
      (entry): entry is NumberToken => entry.type === "number" && entry.value === base
    );
    if (existing) {
      byName.set(cssName, existing);
      bound += 1;
      return existing.id;
    }

    const token = createNumberToken(tokenNameOf(cssName), base, category);
    if (dark !== undefined) {
      token.modes = { [DARK_MODE.id]: dark };
      usedDarkNumber = true;
    }
    minted.push(token);
    byName.set(cssName, token);
    bound += 1;
    return token.id;
  };

  const nameFor = (property: string | readonly string[], authored: AuthoredLookup): string | undefined => {
    for (const candidate of typeof property === "string" ? [property] : property) {
      const name = varNameOf(authored(candidate));
      if (name) return name;
    }
    return undefined;
  };

  return {
    tokens: minted,
    get modes(): DocumentMode[] {
      return usedDarkColor ? [DARK_MODE] : [];
    },
    get numberModes(): DocumentMode[] {
      return usedDarkNumber ? [DARK_MODE] : [];
    },
    get bound(): number {
      return bound;
    },
    lookup(authored: AuthoredLookup): TokenLookup {
      return {
        name: (property) => nameFor(property, authored),
        color: (property, computed) => {
          const cssName = nameFor(property, authored);
          return cssName ? colorToken(cssName, computed, declarationsFor(cssName, authored)) : undefined;
        },
        number: (property, computed) => {
          const cssName = nameFor(property, authored);
          return cssName
            ? numberToken(cssName, computed, declarationsFor(cssName, authored), categoryFor(property, cssName))
            : undefined;
        }
      };
    }
  };
}

/**
 * Which Number Token category a binding belongs to.
 *
 * The PROPERTY decides first — a `--md` bound to a radius is a radius whatever
 * it is called — and the name is only consulted for a binding the property
 * cannot place, such as a width written straight onto a frame.
 */
export function categoryFor(property: string | readonly string[], cssName: string): NumberTokenCategory {
  const first = typeof property === "string" ? property : property[0] ?? "";
  if (first.startsWith("border-") && first.endsWith("-radius")) return "radius";
  if (first === "gap" || first === "row-gap" || first === "column-gap") return "spacing";
  if (first.startsWith("padding")) return "spacing";
  if (first === "font-size" || first === "letter-spacing" || first === "line-height") return "typography";
  if (first.endsWith("-width")) return "stroke";

  const name = cssName.replace(/^--/, "").toLowerCase();
  if (name.includes("radius")) return "radius";
  if (/space|spacing|gap|pad|margin|inset/.test(name)) return "spacing";
  if (/font|text|type|leading|tracking/.test(name)) return "typography";
  if (/border|stroke|outline|ring/.test(name)) return "stroke";
  if (/shadow|blur|elevation/.test(name)) return "effect";
  return "size";
}

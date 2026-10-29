/**
 * The two design-system tables a document carries, handed to the read path and
 * the write path together.
 *
 * `doc.tokens[]` is a value and `doc.styles[]` is a set of declarations, and an
 * id lives in exactly one of them. Every reader therefore needs BOTH tables, and
 * the two used to travel as one `Map<string, DesignStyle>` built from
 * `doc.styles` — a shape that cannot say which table an id was found in, which
 * is what let a token lookup quietly resolve against a style table. One object
 * also makes the compiler name every call site when the shape changes.
 */

import type {
  ColorToken,
  DesignDocument,
  DesignStyle,
  DesignToken,
  NumberToken
} from "../dsl/types";

export interface StyleTables {
  tokens: readonly DesignToken[];
  styles: readonly DesignStyle[];
}

export function styleTables(doc: Pick<DesignDocument, "tokens" | "styles">): StyleTables {
  return { tokens: doc.tokens ?? [], styles: doc.styles ?? [] };
}

/**
 * The lookup maps a document's tables are read through, kept for as long as the
 * arrays they describe.
 *
 * `syncDualStorage` asks once per element, and a page has a thousand of them: the
 * two maps were rebuilt a thousand times per normalize from the same two arrays,
 * which measured 4.2 ms of a 4.2 ms pass. A table is replaced wholesale rather
 * than edited in place (every writer maps it into a new array), so identity is
 * the version, and the size check catches the one writer that appends.
 */
const styleMaps = new WeakMap<readonly DesignStyle[], Map<string, DesignStyle>>();
const tokenMaps = new WeakMap<readonly DesignToken[], Map<string, DesignToken>>();

export function tokenMap(tokens: readonly DesignToken[]): Map<string, DesignToken> {
  const cached = tokenMaps.get(tokens);
  if (cached && cached.size === tokens.length) return cached;
  const map = new Map(tokens.map((token) => [token.id, token]));
  tokenMaps.set(tokens, map);
  return map;
}

export function styleMap(styles: readonly DesignStyle[]): Map<string, DesignStyle> {
  const cached = styleMaps.get(styles);
  if (cached && cached.size === styles.length) return cached;
  const map = new Map(styles.map((style) => [style.id, style]));
  styleMaps.set(styles, map);
  return map;
}

/** `modes[theme] ?? value` — a token's other half for the mode in scope. */
export function colorTokenValue(token: ColorToken, theme?: string): string {
  if (theme && token.modes && typeof token.modes[theme] === "string") return token.modes[theme];
  return token.value;
}

export function numberTokenValue(token: NumberToken, theme?: string): number {
  if (theme && token.modes && typeof token.modes[theme] === "number") return token.modes[theme];
  return token.value;
}

export function isColorTokenType(token: DesignToken): token is ColorToken {
  return token.type === "color";
}

export function isNumberTokenType(token: DesignToken): token is NumberToken {
  return token.type === "number";
}

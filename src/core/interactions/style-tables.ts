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

export function tokenMap(tokens: readonly DesignToken[]): Map<string, DesignToken> {
  return new Map(tokens.map((token) => [token.id, token]));
}

export function styleMap(styles: readonly DesignStyle[]): Map<string, DesignStyle> {
  return new Map(styles.map((style) => [style.id, style]));
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

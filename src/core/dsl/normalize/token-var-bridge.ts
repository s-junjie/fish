/**
 * Token-to-`var()` bridge and slot reference resolver.
 *
 * Keeps token table indexing, `$token` / `var(--name[, fallback])` parsing,
 * mode-aware lookup, and typed slot error reporting separate from the element
 * AST rewriter in `token-shorthand.ts`.
 */

import type { ColorToken, DesignToken, NumberToken } from "../types";
import { normalizeTokens } from "./tokens";
import { numberModeOf, themeOf, tryColorTokenValue, tryNumberTokenValue } from "../token-value";
import { normalizeVarName, splitTopComma, type TokenVarFallback, type Variables } from "./resolve-values";
import { isPlainObject, type NormalizationRepair } from "./shared";

/** `$x` — one prefix, no function call. `/` stays legal so a real name works. */
const TOKEN_REF = /^\$([A-Za-z0-9._/-]+)$/;

export function parseTokenRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = TOKEN_REF.exec(value.trim());
  return match ? match[1] : null;
}

/** Parses a whole-value CSS `var(--name[, fallback])` call, keeping `calc(...)` intact. */
export function parseVarCall(value: unknown): { rawName: string; varName: string; fallback?: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 6 || trimmed.slice(0, 4).toLowerCase() !== "var(") return null;
  let depth = 1;
  let close = -1;
  for (let i = 4; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close !== trimmed.length - 1) return null;
  const { name, fallback } = splitTopComma(trimmed.slice(4, close));
  const rawName = name.trim();
  const varName = normalizeVarName(rawName);
  if (!varName) return null;
  return { rawName, varName, fallback };
}

/** `color/surface` → `color-surface`: the shape an author can type. */
const slugOf = (name: string): string => name.trim().toLowerCase().replace(/[\s/]+/g, "-");

/**
 * The tokens a document declares, indexed three ways.
 *
 * Built through `normalizeTokens` rather than off the raw array so the table
 * holds exactly what the document will hold — a synthesised id, a missing name
 * defaulted to it, an invalid value already dropped. Mirroring those rules here
 * would be a second opinion about which entries exist.
 */
export interface TokenRefTable {
  byId: Map<string, DesignToken>;
  byName: Map<string, DesignToken[]>;
  bySlug: Map<string, DesignToken[]>;
  /** Names the raw table declares but normalize dropped — the honest diagnosis. */
  dropped: Set<string>;
  empty: boolean;
}

export function buildTokenRefTable(rawTokens: unknown): TokenRefTable {
  const tokens = normalizeTokens(rawTokens);
  const byId = new Map<string, DesignToken>();
  const byName = new Map<string, DesignToken[]>();
  const bySlug = new Map<string, DesignToken[]>();
  const dropped = new Set<string>();

  if (Array.isArray(rawTokens)) {
    for (const entry of rawTokens) {
      if (isPlainObject(entry) && typeof entry.name === "string" && entry.name.trim()) {
        dropped.add(entry.name.trim());
      }
    }
  }

  const push = (map: Map<string, DesignToken[]>, key: string, token: DesignToken) => {
    const list = map.get(key);
    if (list) list.push(token);
    else map.set(key, [token]);
  };

  for (const token of tokens) {
    byId.set(token.id, token);
    push(byName, token.name, token);
    push(bySlug, slugOf(token.name), token);
    push(bySlug, slugOf(token.id), token);
    dropped.delete(token.name);
  }

  return {
    byId,
    byName,
    bySlug,
    dropped,
    // "no table to consult" is a document that declares NO tokens — not one
    // whose only entries were dropped. The second still has to be walked, or a
    // reference to the dropped entry is left in place with no word said.
    empty: !Array.isArray(rawTokens) || rawTokens.length === 0
  };
}

export type TokenResolution =
  | { token: DesignToken }
  | { error: "unknown" | "ambiguous" | "dropped"; ref: string };

/**
 * Resolve a reference: id first (it is unique by construction), then the exact
 * name, then the slug. A tie is never resolved by guessing — two tokens that
 * slug to the same word are a fact about the document, and picking one would
 * bind a layer to a token the author cannot see it pointing at.
 */
export function resolveTokenRef(ref: string, table: TokenRefTable): TokenResolution {
  const byId = table.byId.get(ref);
  if (byId) return { token: byId };

  const byName = table.byName.get(ref);
  if (byName?.length === 1) return { token: byName[0] };
  if (byName && byName.length > 1) return { error: "ambiguous", ref };

  const slug = slugOf(ref);
  const bySlug = table.bySlug.get(slug);
  if (bySlug?.length === 1) return { token: bySlug[0] };
  if (bySlug && bySlug.length > 1) return { error: "ambiguous", ref };

  // A name the document declares but normalize dropped has a real cause worth
  // naming: "no such token" would send the author looking for a typo that is
  // not there.
  for (const name of table.dropped) if (slugOf(name) === slug) return { error: "dropped", ref };
  return { error: "unknown", ref };
}

/** The parts of a document a rewrite needs: the table and the modes in scope. */
export interface ShorthandModes {
  activeTheme?: unknown;
  activeNumberMode?: unknown;
  modes?: unknown;
  numberModes?: unknown;
}

export interface TokenSlotContext {
  table: TokenRefTable;
  /** The effective mode at this node: its own override, else the inherited one. */
  theme: string;
  numberMode: string;
  /** Document CSS `variables`, which take precedence over `tokens[]` for `var(--x)`. */
  vars?: Variables;
}

export type SlotResolution =
  | { token: DesignToken; label: string }
  | { error: "unknown" | "ambiguous" | "dropped"; label: string };

export const colorOf = (token: DesignToken, ctx: TokenSlotContext): string | undefined =>
  token.type === "color" ? tryColorTokenValue(token as ColorToken, ctx.theme, ctx.table.byId) : undefined;

export const numberOf = (token: DesignToken, ctx: TokenSlotContext): number | undefined =>
  token.type === "number" ? tryNumberTokenValue(token as NumberToken, ctx.numberMode, ctx.table.byId) : undefined;

export function reportSlotError(
  error: "unknown" | "ambiguous" | "dropped" | "type",
  label: string,
  where: string,
  wants: "colour" | "number",
  repairs: NormalizationRepair[]
): void {
  const message =
    error === "unknown"
      ? `${label} names no token; the declaration was dropped`
      : error === "ambiguous"
        ? `${label} matches more than one token by name; nothing was bound`
        : error === "dropped"
          ? `${label} names a token whose value was dropped; nothing was bound`
          : `${label} is not a ${wants} token`;
  repairs.push({ kind: "token", path: `${where}`, message });
}

/**
 * Resolves a single `$name` or `var(--name[, fallback])` reference against `table`.
 *
 * Explicit entries in `doc.variables` own their `var(--name)` (returning `null`
 * so `resolveValueTokens` handles them); unknown `var(--name)` also returns `null`
 * so missing custom properties keep reporting through the normal `var()` channel,
 * while a `var(--missing, $fallback)` unwraps recursively.
 */
export function resolveSlotRef(
  value: unknown,
  table: TokenRefTable,
  vars?: Variables,
  depth = 0
): SlotResolution | null {
  if (depth > 8) return null;
  const dollar = parseTokenRef(value);
  if (dollar !== null) {
    const found = resolveTokenRef(dollar, table);
    return "token" in found
      ? { token: found.token, label: `"$${dollar}"` }
      : { error: found.error, label: `"$${dollar}"` };
  }

  const call = parseVarCall(value);
  if (!call) return null;
  if (vars && Object.prototype.hasOwnProperty.call(vars, call.varName)) return null;

  let found: TokenResolution =
    call.rawName !== call.varName ? resolveTokenRef(call.rawName, table) : { error: "unknown", ref: call.varName };
  if ("error" in found && found.error === "unknown") {
    found = resolveTokenRef(call.varName, table);
  }
  const label = `"var(${call.rawName})"`;
  if ("token" in found) return { token: found.token, label };
  if (found.error === "unknown") {
    if (call.fallback !== undefined && call.fallback.trim() !== "") {
      return resolveSlotRef(call.fallback, table, vars, depth + 1);
    }
    return null;
  }
  return { error: found.error, label };
}

export function finishColorSlot(
  resolved: SlotResolution,
  ctx: TokenSlotContext,
  where: string,
  repairs: NormalizationRepair[]
): { token: ColorToken; color: string } | null {
  if ("error" in resolved) {
    reportSlotError(resolved.error, resolved.label, where, "colour", repairs);
    return null;
  }
  const color = colorOf(resolved.token, ctx);
  if (color === undefined) {
    reportSlotError("type", resolved.label, where, "colour", repairs);
    return null;
  }
  return { token: resolved.token as ColorToken, color };
}

export function finishNumberSlot(
  resolved: SlotResolution,
  ctx: TokenSlotContext,
  where: string,
  repairs: NormalizationRepair[]
): { token: NumberToken; value: number } | null {
  if ("error" in resolved) {
    reportSlotError(resolved.error, resolved.label, where, "number", repairs);
    return null;
  }
  const value = numberOf(resolved.token, ctx);
  if (value === undefined) {
    reportSlotError("type", resolved.label, where, "number", repairs);
    return null;
  }
  return { token: resolved.token as NumberToken, value };
}

/**
 * A reference field's value (`tokenId`, `tokenBindings[*]`) read as a token.
 *
 * These fields publish an ID, and an id is minted — so the name is accepted too,
 * and a value that resolves to nothing is left exactly as written: the field's
 * contract is still "a reference", and `validate-tokens` already reports one
 * that points nowhere. Rewriting a typo here would delete the only evidence.
 */
export function lookupToken(value: unknown, table: TokenRefTable): DesignToken | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const ref = text.startsWith("$") ? parseTokenRef(text) : text;
  if (!ref) return undefined;
  const found = resolveTokenRef(ref, table);
  return "token" in found ? found.token : undefined;
}

/**
 * Fallback resolver for `var(--name)` inside compound expressions (`calc(...)`),
 * unbindable box properties (`margin`), and document-level surfaces. Explicit
 * `doc.variables` win over this fallback before it is ever consulted.
 */
export function createTokenVarResolver(
  rawTokens: unknown,
  modes: ShorthandModes
): TokenVarFallback | undefined {
  const table = buildTokenRefTable(rawTokens);
  if (table.empty) return undefined;
  const docTheme = themeOf(modes);
  const docNumberMode = numberModeOf(modes);
  return (key, nodeModes) => {
    let found = resolveTokenRef(key, table);
    if ("error" in found && found.error === "unknown") {
      found = resolveTokenRef(`--${key}`, table);
    }
    if (!("token" in found)) return undefined;
    const tok = found.token;
    if (tok.type === "color") {
      return tryColorTokenValue(tok as ColorToken, nodeModes?.theme || docTheme, table.byId);
    }
    const v = tryNumberTokenValue(tok as NumberToken, nodeModes?.numberMode || docNumberMode, table.byId);
    return v !== undefined ? `${v}px` : undefined;
  };
}

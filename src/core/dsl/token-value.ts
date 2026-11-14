/**
 * A token's value for the mode in scope — the one rule, for both tables.
 *
 * `doc.tokens[]` holds one base value plus a `modes` entry per mode, and two
 * readers need to answer "what is this token worth RIGHT NOW": the editor's sync
 * pass (`syncDualStorage`) and, since `$token` shorthands exist, the reader that
 * turns an author's reference into a stored value at normalize time. They must
 * answer the same, or a document renders one colour on load and another the
 * moment something re-syncs it.
 *
 * When a slot holds an alias (`{ ref: targetId }`), resolution walks the chain
 * within the same mode scope and the same token type, guarded against cycles
 * and dangling targets.
 */

import type {
  ColorToken,
  ColorTokenValue,
  DesignToken,
  NumberToken,
  NumberTokenValue,
  TokenAliasRef
} from "./types";

/** The default mode id if none is specified on the document. */
export const DEFAULT_THEME = "default";

const MAX_ALIAS_DEPTH = 16;

export type TokenLookup = ReadonlyMap<string, DesignToken> | readonly DesignToken[];

export type TokenResolveError = "cycle" | "dangling" | "type-mismatch";

export type TokenResolution<T> =
  | { ok: true; value: T; isAlias: boolean; chain: string[] }
  | { ok: false; error: TokenResolveError; isAlias: true; chain: string[] };

export function isTokenAliasRef(value: unknown): value is TokenAliasRef {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as TokenAliasRef).ref === "string" &&
    (value as TokenAliasRef).ref.length > 0
  );
}

const arrayMapCache = new WeakMap<readonly DesignToken[], ReadonlyMap<string, DesignToken>>();

export function toTokenMap(tokens: TokenLookup): ReadonlyMap<string, DesignToken>;
export function toTokenMap(tokens?: TokenLookup): ReadonlyMap<string, DesignToken> | undefined;
export function toTokenMap(tokens?: TokenLookup): ReadonlyMap<string, DesignToken> | undefined {
  if (!tokens) return undefined;
  if (tokens instanceof Map) return tokens;
  if (Array.isArray(tokens)) {
    // doc.tokens is only replaced immutably; array identity remains valid even when duplicate ids collapse size.
    const cached = arrayMapCache.get(tokens);
    if (cached) return cached;
    const built = new Map<string, DesignToken>();
    for (const t of tokens) {
      if (!built.has(t.id)) built.set(t.id, t);
    }
    arrayMapCache.set(tokens, built);
    return built;
  }
  return tokens as ReadonlyMap<string, DesignToken>;
}

export function lookupToken(tokens: TokenLookup | undefined, id: string): DesignToken | undefined {
  return toTokenMap(tokens)?.get(id);
}

function resolveSlot<T extends string | number>(
  token: DesignToken,
  expectedType: "color" | "number",
  mode: string | undefined,
  tokens: ReadonlyMap<string, DesignToken> | undefined,
  isLiteral: (v: unknown) => v is T,
  visited: Set<string>,
  depth: number
): TokenResolution<T> {
  const slot =
    mode && token.modes && token.modes[mode] !== undefined
      ? token.modes[mode]
      : token.value;

  if (isLiteral(slot)) {
    return { ok: true, value: slot, isAlias: depth > 0, chain: [token.id] };
  }

  if (!isTokenAliasRef(slot)) {
    return { ok: false, error: "type-mismatch", isAlias: true, chain: [token.id] };
  }

  const targetId = slot.ref;
  if (visited.has(targetId) || depth >= MAX_ALIAS_DEPTH) {
    return { ok: false, error: "cycle", isAlias: true, chain: [token.id, targetId] };
  }

  const target = tokens?.get(targetId);
  if (!target) {
    return { ok: false, error: "dangling", isAlias: true, chain: [token.id, targetId] };
  }
  if (target.type !== expectedType) {
    return { ok: false, error: "type-mismatch", isAlias: true, chain: [token.id, targetId] };
  }

  const nextVisited = new Set(visited);
  nextVisited.add(targetId);
  const inner = resolveSlot(target, expectedType, mode, tokens, isLiteral, nextVisited, depth + 1);
  return {
    ...inner,
    isAlias: true,
    chain: [token.id, ...inner.chain]
  };
}

const isStringLiteral = (v: unknown): v is string => typeof v === "string";
const isFiniteNumberLiteral = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function resolveColorTokenValue(
  token: ColorToken,
  theme?: string,
  tokens?: TokenLookup
): TokenResolution<string> {
  return resolveSlot(
    token,
    "color",
    theme,
    toTokenMap(tokens),
    isStringLiteral,
    new Set([token.id]),
    0
  );
}

export function resolveNumberTokenValue(
  token: NumberToken,
  mode?: string,
  tokens?: TokenLookup
): TokenResolution<number> {
  return resolveSlot(
    token,
    "number",
    mode,
    toTokenMap(tokens),
    isFiniteNumberLiteral,
    new Set([token.id]),
    0
  );
}

/** Resolves a colour token's value in `theme`, returning `undefined` when an alias is broken. */
export function tryColorTokenValue(
  token: ColorToken,
  theme?: string,
  tokens?: TokenLookup
): string | undefined {
  const res = resolveColorTokenValue(token, theme, tokens);
  return res.ok ? res.value : undefined;
}

/** Resolves a number token's value in `mode`, returning `undefined` when an alias is broken. */
export function tryNumberTokenValue(
  token: NumberToken,
  mode?: string,
  tokens?: TokenLookup
): number | undefined {
  const res = resolveNumberTokenValue(token, mode, tokens);
  return res.ok ? res.value : undefined;
}

/** `modes[theme] ?? value` — a colour token's resolved hex for the mode in scope. */
export function colorTokenValue(
  token: ColorToken,
  theme?: string,
  tokens?: TokenLookup
): string {
  return tryColorTokenValue(token, theme, tokens) ?? "#000000";
}

/** `modes[mode] ?? value` — a number token's resolved px value for the mode in scope. */
export function numberTokenValue(
  token: NumberToken,
  mode?: string,
  tokens?: TokenLookup
): number {
  return tryNumberTokenValue(token, mode, tokens) ?? 0;
}

/** All `targetId`s that `token` directly references across its base value and modes. */
export function directTokenRefs(token: DesignToken): string[] {
  const refs: string[] = [];
  if (isTokenAliasRef(token.value)) refs.push(token.value.ref);
  if (token.modes) {
    for (const v of Object.values(token.modes)) {
      if (isTokenAliasRef(v)) refs.push(v.ref);
    }
  }
  return refs;
}

/** True if pointing `sourceId` at `targetId` would introduce a reference cycle. */
export function wouldTokenAliasCycle(
  tokens: TokenLookup,
  sourceId: string,
  targetId: string
): boolean {
  if (sourceId === targetId) return true;
  const map = toTokenMap(tokens);
  if (!map) return false;
  const seen = new Set<string>();
  const stack = [targetId];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr === sourceId) return true;
    if (seen.has(curr)) continue;
    seen.add(curr);
    const tok = map.get(curr);
    if (!tok) continue;
    for (const nextRef of directTokenRefs(tok)) {
      stack.push(nextRef);
    }
  }
  return false;
}

/**
 * Returns `seedId` plus every token that directly or transitively aliases it.
 * Used when editing a primitive token so dependent semantic tokens cascade too.
 */
export function collectDependentTokenIds(
  tokens: readonly DesignToken[],
  seedId: string
): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const tok of tokens) {
    for (const refId of directTokenRefs(tok)) {
      const list = reverse.get(refId) ?? [];
      list.push(tok.id);
      reverse.set(refId, list);
    }
  }
  const affected = new Set<string>([seedId]);
  const queue = [seedId];
  while (queue.length > 0) {
    const curr = queue.pop()!;
    for (const parentId of reverse.get(curr) ?? []) {
      if (!affected.has(parentId)) {
        affected.add(parentId);
        queue.push(parentId);
      }
    }
  }
  return affected;
}

/** Helpers for inspecting a raw slot value without resolving aliases. */
export function rawTokenSlot(
  token: ColorToken,
  modeId?: string,
  baseModeId?: string
): ColorTokenValue;
export function rawTokenSlot(
  token: NumberToken,
  modeId?: string,
  baseModeId?: string
): NumberTokenValue;
export function rawTokenSlot(
  token: DesignToken,
  modeId?: string,
  baseModeId?: string
): ColorTokenValue | NumberTokenValue;
export function rawTokenSlot(
  token: DesignToken,
  modeId?: string,
  baseModeId?: string
): ColorTokenValue | NumberTokenValue {
  if (modeId && modeId !== baseModeId && token.modes && token.modes[modeId] !== undefined) {
    return token.modes[modeId];
  }
  return token.value;
}

/** The parts of a document that decide which mode a token resolves in. */
interface ModeSource {
  activeTheme?: unknown;
  activeNumberMode?: unknown;
  modes?: unknown;
  numberModes?: unknown;
}

/**
 * The first declared mode id, or nothing.
 *
 * Malformed entries are skipped rather than read: a mode whose `id` is not a
 * string cannot key a token's `modes` table anyway, and answering with it would
 * put a number where every caller expects a table key.
 */
function firstModeId(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/**
 * The colour mode in scope. Falls back to the first declared mode, then to
 * `DEFAULT_THEME` — a token may file a value under "default" in a document that
 * declares no mode list at all.
 */
export function themeOf(doc: ModeSource): string {
  if (typeof doc.activeTheme === "string" && doc.activeTheme) return doc.activeTheme;
  return firstModeId(doc.modes) ?? DEFAULT_THEME;
}

/**
 * The NUMBER mode in scope.
 *
 * Never the colour mode: brightness and density are independent, and a colour
 * switch that moved every radius is the defect the split exists to remove. The
 * element-level override is the one place the two are allowed to meet, and that
 * rule lives at the call site (`syncDualStorage`), not here.
 */
export function numberModeOf(doc: ModeSource): string {
  if (typeof doc.activeNumberMode === "string" && doc.activeNumberMode) return doc.activeNumberMode;
  return firstModeId(doc.numberModes) ?? DEFAULT_THEME;
}

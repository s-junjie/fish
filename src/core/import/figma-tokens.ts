/**
 * Figma variables → FISH design tokens.
 *
 * A Figma variable is already the thing a FISH token is: one name, one value per
 * mode. What does not survive the crossing is the BINDING — a layer bound to a
 * variable exports as the literal the variable resolved to, and the import would
 * otherwise arrive as a flat colour that happens to match. `boundVariables` on
 * each node is what names the variable again, and this mints one FISH token per
 * variable a layer actually binds.
 *
 * An alias (`--a` pointing at `--b`) has no FISH counterpart — the token system
 * has no reference token — so an alias is followed to the value it stands for and
 * shares the target's token. Two names, one token, which is what the designer
 * meant: change the base colour and both follow.
 */

import type {
  ColorToken,
  DesignToken,
  DocumentMode,
  NumberToken,
  NumberTokenCategory
} from "../dsl/types";
import { createNumberToken } from "../interactions/number-token-ops";
import { createColorToken } from "../interactions/token-ops";
import { composeColorAlpha } from "../geometry/color-utils";
import { figmaColor } from "./figma-paint";
import type {
  FigmaNode,
  FigmaVariable,
  FigmaVariableAlias,
  FigmaVariableCollection,
  FigmaVariableValue
} from "./figma-types";

export const DARK_MODE: DocumentMode = { id: "dark", name: "Dark" };

/** A Figma property → the DSL field it binds, for the properties FISH can hold. */
const SCALAR_FIELDS: Record<string, string> = {
  cornerRadius: "borderRadius",
  topLeftRadius: "borderRadius",
  topRightRadius: "borderRadius",
  bottomRightRadius: "borderRadius",
  bottomLeftRadius: "borderRadius",
  itemSpacing: "gap",
  strokeWeight: "strokeWidth",
  fontSize: "fontSize",
  letterSpacing: "letterSpacing",
  width: "width",
  height: "height"
};

/** The four paddings, which only bind as one when Figma bound all four alike. */
const PADDINGS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;

export interface FigmaTokensOptions {
  /** The document's own tokens, so a second import reuses a token it already made. */
  tokens?: readonly DesignToken[];
}

export interface FigmaTokens {
  /** One token per referenced variable, in the order it was first bound. */
  readonly tokens: DesignToken[];
  /** Modes the COLOUR collections declare beyond each one's default. */
  readonly colorModes: DocumentMode[];
  /** Modes the NUMBER collections declare beyond each one's default. */
  readonly numberModes: DocumentMode[];
  /** How many layer properties were bound. */
  readonly bound: number;
  /**
   * The token one variable becomes, minting it on first mention.
   *
   * Exposed because a style binds variables too: a colour style whose fill is a
   * semantic variable, a text style whose size is a number token. Those bindings
   * belong to the STYLE, and a style built from the resolved literal would lose
   * the link the moment the token changed.
   */
  token: (variableId: string) => string | undefined;
  /** A lookup over one node's bindings. */
  lookup: (node: FigmaNode) => FigmaTokenLookup;
}

/** What one node's bindings resolve to. */
export interface FigmaTokenLookup {
  /** The token bound to the paint at `index` of `fills` / `strokes`. */
  paint: (channel: "fills" | "strokes", index: number) => string | undefined;
  /** `(DSL field, token id)` for every scalar property this node binds. */
  scalars: () => Array<{ field: string; tokenId: string }>;
}

const isAlias = (value: unknown): value is FigmaVariableAlias =>
  Boolean(value) && typeof value === "object" && typeof (value as FigmaVariableAlias).id === "string";

const isColorValue = (value: unknown): value is { r: number; g: number; b: number; a?: number } =>
  Boolean(value) && typeof value === "object" && typeof (value as { r?: number }).r === "number";

/**
 * A variable's value in one mode, as hex plus the alpha FISH paints beside it.
 *
 * Upper-cased because the rest of the document spells a colour that way: a token
 * holding `#ffffff` beside a layer holding `#FFFFFF` is a duplicate the reuse
 * check below cannot see, and a designer gets two tokens for one colour.
 */
function colorOf(value: FigmaVariableValue): { color: string; opacity?: number } | undefined {
  if (!isColorValue(value)) return undefined;
  const hex = figmaColor({ r: value.r, g: value.g, b: value.b, a: 1 }).toUpperCase();
  const alpha = value.a ?? 1;
  return alpha < 1 ? { color: hex, opacity: alpha } : { color: hex };
}

/** The one encoding a colour token has: any alpha rides in the last hex byte. */
function hexOf(color: { color: string; opacity?: number }): string {
  return color.opacity !== undefined && color.opacity < 1
    ? composeColorAlpha(color.color.slice(0, 7), Math.round(color.opacity * 100))
    : color.color;
}

function numberOf(value: FigmaVariableValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Which Number Token category a variable belongs to.
 *
 * Figma says only `FLOAT`, so the NAME is the whole evidence there is. Radius
 * first: `--radius/*` is the one spacing-like family whose members are never
 * interchangeable with a gap, and getting it wrong puts a corner in the spacing
 * list a designer reaches for when padding a card.
 */
export function categoryOf(name: string): NumberTokenCategory {
  const lower = name.toLowerCase();
  if (lower.includes("radius")) return "radius";
  if (/space|spacing|gap|pad|margin|inset/.test(lower)) return "spacing";
  // Not `size`: a variable called `size/sidebar` is a width, and filing it under
  // typography because the word "size" also names a type scale is worse than
  // leaving it in the one category that makes no claim.
  if (/font|text|type|leading|tracking/.test(lower)) return "typography";
  if (/border|stroke|outline|ring|weight/.test(lower)) return "stroke";
  if (/shadow|blur|elevation/.test(lower)) return "effect";
  return "size";
}

/** A collection mode → the FISH mode id its value is filed under. */
function modeIdOf(mode: { modeId: string; name?: string }): string {
  const name = (mode.name ?? "").trim();
  if (/dark/i.test(name) && !/light/i.test(name)) return DARK_MODE.id;
  return `mode_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || mode.modeId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

export function createFigmaTokens(
  variables: readonly FigmaVariable[] | undefined,
  collections: readonly FigmaVariableCollection[] | undefined,
  options: FigmaTokensOptions = {}
): FigmaTokens {
  const byId = new Map<string, FigmaVariable>();
  for (const variable of variables ?? []) byId.set(variable.id, variable);

  const collectionById = new Map<string, FigmaVariableCollection>();
  for (const collection of collections ?? []) collectionById.set(collection.id, collection);

  const minted: DesignToken[] = [];
  const byVariable = new Map<string, DesignToken>();
  // Two registries, because Figma's collections ARE the two axes: a `Theme`
  // collection drives colours, a `Density` collection drives numbers, and filing
  // a density mode into the colour list is what made every radius in a Numbers
  // table grow a `Dark` column it could never mean.
  const colorModes = new Map<string, DocumentMode>();
  const numberModes = new Map<string, DocumentMode>();
  let bound = 0;

  /**
   * The value a variable holds, following an alias to the one that owns it.
   *
   * The chain is walked rather than read once because an alias may point at an
   * alias — a semantic name over a palette step is how most files are built — and
   * a bounded walk is what keeps a cycle that a file could contain from hanging
   * the import.
   */
  const resolve = (id: string, modeId: string | undefined, depth = 0): { owner: string; value: FigmaVariableValue } | undefined => {
    if (depth > 8) return undefined;
    const variable = byId.get(id);
    if (!variable?.valuesByMode) return undefined;
    const modesOf = collectionById.get(variable.variableCollectionId ?? "")?.modes;
    const key = modeId ?? collectionById.get(variable.variableCollectionId ?? "")?.defaultModeId;
    const chosen = (key && variable.valuesByMode[key]) ?? variable.valuesByMode[Object.keys(variable.valuesByMode)[0]];
    if (chosen === undefined) return undefined;
    if (isAlias(chosen)) return resolve(chosen.id, modeId, depth + 1);
    return { owner: id, value: chosen };
  };

  const reuse = (name: string, matches: (token: DesignToken) => boolean): DesignToken | undefined => {
    for (const token of options.tokens ?? []) {
      if (token.name === name && matches(token)) return token;
    }
    return undefined;
  };

  /** One token per variable, minted on the first binding that names it. */
  const tokenFor = (id: string): DesignToken | undefined => {
    const variable = byId.get(id);
    if (!variable) return undefined;
    const collection = collectionById.get(variable.variableCollectionId ?? "");
    const base = resolve(id, collection?.defaultModeId);
    if (!base) return undefined;

    /* An alias is minted under the variable that OWNS the value, so the semantic
       name and the palette step it points at are one token rather than two that
       happen to hold the same colour. */
    const owner = base.owner;
    const known = byVariable.get(owner);
    if (known) {
      byVariable.set(id, known);
      return known;
    }

    const named = byId.get(owner) ?? variable;
    const owned = collectionById.get(named.variableCollectionId ?? "");
    const name = (named.name ?? "").trim() || "Token";

    const color = colorOf(base.value);
    if (color) {
      const hex = hexOf(color);
      const found = reuse(
        name,
        (entry): entry is ColorToken => entry.type === "color" && entry.value === hex
      );
      const token = found ?? createColorToken(name, hex);
      if (!found) minted.push(token);
      byVariable.set(owner, token);
      byVariable.set(id, token);
      applyColorModes(token as ColorToken, named, owned);
      return token;
    }

    const number = numberOf(base.value);
    if (number !== undefined) {
      const category = categoryOf(name);
      const found = reuse(
        name,
        (entry): entry is NumberToken => entry.type === "number" && entry.value === number
      );
      const token = found ?? createNumberToken(name, number, category);
      if (!found) minted.push(token);
      byVariable.set(owner, token);
      byVariable.set(id, token);
      applyNumberModes(token as NumberToken, named, owned);
      return token;
    }

    return undefined;
  };

  /** Every mode but the collection's own default, as the ids FISH would file it under. */
  const otherModes = (collection: FigmaVariableCollection | undefined): Array<{ modeId: string; id: string; name: string }> => {
    const list: Array<{ modeId: string; id: string; name: string }> = [];
    for (const mode of collection?.modes ?? []) {
      if (mode.modeId === collection?.defaultModeId) continue;
      list.push({ modeId: mode.modeId, id: modeIdOf(mode), name: (mode.name ?? "").trim() || "Mode" });
    }
    return list;
  };

  /**
   * A mode is registered when a token actually FILES a value under it. A
   * collection whose two modes resolve to the same colour carries no information,
   * and publishing it as a document mode gave every token in that table a column
   * that could only ever repeat the base value.
   */
  const register = (registry: Map<string, DocumentMode>, mode: { id: string; name: string }): void => {
    if (!registry.has(mode.id)) registry.set(mode.id, { id: mode.id, name: mode.name });
  };

  const applyColorModes = (token: ColorToken, variable: FigmaVariable, collection: FigmaVariableCollection | undefined): void => {
    for (const mode of otherModes(collection)) {
      const resolved = resolve(variable.id, mode.modeId);
      const color = resolved ? colorOf(resolved.value) : undefined;
      if (!color) continue;
      const hex = hexOf(color);
      if (hex === token.value) continue;
      token.modes = { ...(token.modes ?? {}), [mode.id]: hex };
      register(colorModes, mode);
    }
  };

  const applyNumberModes = (token: NumberToken, variable: FigmaVariable, collection: FigmaVariableCollection | undefined): void => {
    for (const mode of otherModes(collection)) {
      const resolved = resolve(variable.id, mode.modeId);
      const value = resolved ? numberOf(resolved.value) : undefined;
      if (value === undefined || value === token.value) continue;
      token.modes = { ...(token.modes ?? {}), [mode.id]: value };
      register(numberModes, mode);
    }
  };

  const aliasAt = (channel: "fills" | "strokes", index: number, node: FigmaNode): FigmaVariableAlias | undefined => {
    const boundList = node.boundVariables?.[channel];
    if (!Array.isArray(boundList)) return undefined;
    const paints = node[channel];
    if (!Array.isArray(paints)) return undefined;
    // The alias list is indexed by Figma's paint array, which includes the
    // invisible layers the mapper drops, so the two are aligned on what is
    // DRAWN rather than on what Figma listed.
    let cursor = -1;
    for (let i = 0; i < paints.length; i++) {
      if ((paints[i] as { visible?: boolean } | undefined)?.visible === false) continue;
      cursor += 1;
      if (cursor === index) {
        const entry = boundList[i];
        return isAlias(entry) ? entry : undefined;
      }
    }
    return undefined;
  };

  return {
    tokens: minted,
    get colorModes(): DocumentMode[] {
      return [...colorModes.values()];
    },
    get numberModes(): DocumentMode[] {
      return [...numberModes.values()];
    },
    get bound(): number {
      return bound;
    },
    token: (variableId) => tokenFor(variableId)?.id,
    lookup(node: FigmaNode): FigmaTokenLookup {
      return {
        paint: (channel, index) => {
          const alias = aliasAt(channel, index, node);
          if (!alias) return undefined;
          const token = tokenFor(alias.id);
          if (!token) return undefined;
          bound += 1;
          return token.id;
        },
        scalars: () => {
          const out: Array<{ field: string; tokenId: string }> = [];
          const bindings = node.boundVariables ?? {};

          // The four paddings bind as ONE field, and only when all four name the
          // same variable: the DSL's uniform padding is one number, so three
          // bound sides and a loose fourth have no honest spelling.
          const paddingIds = PADDINGS.map((key) => (isAlias(bindings[key]) ? bindings[key].id : undefined));
          if (paddingIds.every((id): id is string => typeof id === "string") && new Set(paddingIds).size === 1) {
            const token = tokenFor(paddingIds[0] as string);
            if (token) out.push({ field: "padding", tokenId: token.id });
          }

          for (const [key, value] of Object.entries(bindings)) {
            if (PADDINGS.includes(key as (typeof PADDINGS)[number])) continue;
            if (!isAlias(value)) continue;
            const field = SCALAR_FIELDS[key];
            if (!field) continue;
            const token = tokenFor(value.id);
            if (!token) continue;
            out.push({ field, tokenId: token.id });
          }

          bound += out.length;
          return out;
        }
      };
    }
  };
}

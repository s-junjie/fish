/**
 * Figma styles → FISH styles, with the variables they are built from still linked.
 *
 * A style and a token are two different things on both sides of the crossing, and
 * the DSL keeps them apart the same way Figma does: `fillStyleId` / `textStyleId`
 * / `effectStyleId` name a STYLE, while `paint.tokenId`, `effect.tokenId` and
 * `TextStyle.tokenBindings` name a TOKEN. A Figma colour style whose fill is a
 * semantic variable therefore has a faithful FISH spelling — a `PaintStyle` whose
 * paint carries `tokenId` — and building it from the resolved literal instead
 * would lose the link the moment the token changed.
 *
 * Styles are minted LAZILY, on the first layer that points at one. A Figma file's
 * style library is the whole team's; importing one board should not arrive with
 * forty styles nobody in it uses.
 *
 * Values are never invented. REST's `file.styles` is a directory with no values,
 * so a payload in that shape binds nothing — a style built from a guess is worse
 * than a style that did not arrive.
 */

import type { DesignStyle, Paint, PaintStack, TextStyle } from "../dsl/types";
import { createEffectStyle, createPaintStyle, createTextStyle } from "../interactions/style-ops";
import { figmaColor, mapFigmaEffects, mapFigmaFills, type ImageRefResolver } from "./figma-paint";
import { textStyleOf } from "./figma-text";
import type { FigmaEffect, FigmaPaint, FigmaStyle, FigmaTypeStyle, FigmaVariableAlias } from "./figma-types";
import type { FigmaTokens } from "./figma-tokens";

export interface FigmaStyleOptions {
  /** The document's own styles, so a second import reuses what is already there. */
  styles?: readonly DesignStyle[];
  /** Byte lookup for an IMAGE fill inside a style definition. */
  resolve?: ImageRefResolver;
}

export interface FigmaStyleIndex {
  /** The styles minted so far, in the order the walk first asked for them. */
  readonly styles: DesignStyle[];
  /** How many layer channels point at one of them. */
  readonly links: number;
  /** Style definitions this import could not express, named rather than dropped. */
  readonly unsupported: Array<{ id: string; name: string; styleType: string }>;
  /** The FISH style id a layer's style channel resolves to. */
  link: (figmaStyleId: string | undefined) => string | undefined;
}

const isAlias = (value: unknown): value is FigmaVariableAlias =>
  Boolean(value) && typeof value === "object" && typeof (value as FigmaVariableAlias).id === "string";

const aliasOf = (value: unknown): FigmaVariableAlias | undefined => (isAlias(value) ? value : undefined);

/** Positional aliases, one per paint — the shape a paint channel binds in. */
const aliasList = (value: unknown): Array<FigmaVariableAlias | null> | undefined =>
  Array.isArray(value) ? (value as Array<FigmaVariableAlias | null>) : undefined;

const firstSolid = (fills: FigmaPaint[] | undefined): string | undefined => {
  const paint = (fills ?? []).find((f) => f.visible !== false);
  if (!paint || paint.type !== "SOLID" || !paint.color) return undefined;
  return figmaColor(paint.color, paint.opacity ?? 1);
};

/** What a style's definition actually IS, for the "already have one" comparison. */
function shapeOf(style: DesignStyle): unknown {
  switch (style.styleType) {
    case "paint":
      return style.paints;
    case "text":
      return style.style;
    case "effect":
      return style.effects;
    case "stroke":
      return style.strokes;
  }
}

export function createFigmaStyles(
  payload: Record<string, FigmaStyle> | FigmaStyle[] | undefined,
  tokens: FigmaTokens | undefined,
  options: FigmaStyleOptions = {}
): FigmaStyleIndex {
  const byId = new Map<string, FigmaStyle>();
  const byFigmaId = new Map<string, string>();
  const failed = new Set<string>();
  const minted: DesignStyle[] = [];
  const unsupported: FigmaStyleIndex["unsupported"] = [];
  let links = 0;

  // A directory is not a definition. REST hands back `{ key, name, styleType }`
  // with no values, so there is nothing here a FISH style could be built from.
  for (const def of Array.isArray(payload) ? payload : []) {
    if (!def || typeof def.id !== "string") continue;
    byId.set(def.id, def);
    if (def.key) byId.set(def.key, def);
  }

  const styleName = (style: FigmaStyle): string => (style.name ?? "").trim() || "Style";

  const reuse = (name: string, styleType: string, shape: unknown): DesignStyle | undefined =>
    (options.styles ?? []).find(
      (style) => style.name === name && style.styleType === styleType && JSON.stringify(shapeOf(style)) === JSON.stringify(shape)
    );

  const keep = (made: DesignStyle): string => {
    minted.push(made);
    return made.id;
  };

  const mintPaint = (style: FigmaStyle): string | undefined => {
    const source = Array.isArray(style.paints) ? style.paints : undefined;
    const paints = mapFigmaFills(source, options.resolve);
    if (!paints) return undefined;

    // A style binds variables the same way a layer does, and the binding is on
    // the PAINT — a gradient's stops are not one variable, so nothing is guessed
    // past `color`.
    const positional = aliasList(style.boundVariables?.paints) ?? aliasList(style.boundVariables?.fills);
    for (let i = 0; i < paints.length; i++) {
      const bound = aliasOf((source?.[i] as { boundVariables?: { color?: unknown } } | undefined)?.boundVariables?.color);
      const alias = bound ?? (positional ? aliasOf(positional[i]) : undefined);
      const tokenId = alias && tokens?.token(alias.id);
      if (tokenId) paints[i] = { ...(paints[i] as Paint), tokenId } as Paint;
    }

    // A colour style is a STYLE, even when it is one solid bound to one
    // variable: the binding lives on its paint (`paints[0].tokenId`) and the
    // style keeps its own name. Collapsing it into the token threw that name
    // away, which is fine only while a token and a style are the same shape.
    const name = styleName(style);
    const found = reuse(name, "paint", paints);
    return found ? found.id : keep(createPaintStyle(name, paints as PaintStack));
  };

  const mintText = (style: FigmaStyle): string | undefined => {
    const type: FigmaTypeStyle = {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      italic: style.italic,
      letterSpacing: style.letterSpacing,
      lineHeightPx: style.lineHeightPx,
      lineHeightPercent: style.lineHeightPercent,
      textCase: style.textCase,
      textDecoration: style.textDecoration
    };
    const text: TextStyle = textStyleOf(type, firstSolid(style.fills));

    const bindings: Record<string, string> = {};
    for (const [field, key] of [
      ["fontSize", "fontSize"],
      ["letterSpacing", "letterSpacing"]
    ] as const) {
      const alias = aliasOf(style.boundVariables?.[key]);
      const tokenId = alias && tokens?.token(alias.id);
      if (tokenId) bindings[field] = tokenId;
    }
    if (Object.keys(bindings).length > 0) text.tokenBindings = bindings;

    const name = styleName(style);
    const found = reuse(name, "text", text);
    return found ? found.id : keep(createTextStyle(name, text));
  };

  const mintEffect = (style: FigmaStyle): string | undefined => {
    const source = Array.isArray(style.effects) ? (style.effects as FigmaEffect[]) : undefined;
    const effects = mapFigmaEffects(source);
    if (!effects) return undefined;

    // `mapFigmaEffects` drops hidden and unknown effects, so the two lists line up
    // only when nothing was dropped. Anything else would attach a binding to the
    // wrong shadow, which is a link to a token that describes a different layer.
    const drawn = (source ?? []).filter((e) => e.visible !== false);
    if (drawn.length === effects.length) {
      for (let i = 0; i < effects.length; i++) {
        const aliases = drawn[i]?.boundVariables as Record<string, unknown> | undefined;
        if (!aliases) continue;
        const color = aliasOf(aliases.color);
        const colorToken = color && tokens?.token(color.id);
        const bindings: Record<string, string> = {};
        for (const key of ["radius", "spread"] as const) {
          const alias = aliasOf(aliases[key]);
          const tokenId = alias && tokens?.token(alias.id);
          if (tokenId) bindings[key] = tokenId;
        }
        const effect = effects[i] as unknown as Record<string, unknown>;
        if (colorToken) effect.tokenId = colorToken;
        if (Object.keys(bindings).length > 0) effect.tokenBindings = bindings;
      }
    }

    const name = styleName(style);
    const found = reuse(name, "effect", effects);
    return found ? found.id : keep(createEffectStyle(name, effects));
  };

  const mint = (style: FigmaStyle): string | undefined => {
    switch ((style.styleType ?? "").toUpperCase()) {
      case "PAINT":
      case "FILL":
        return mintPaint(style);
      case "TEXT":
        return mintText(style);
      case "EFFECT":
        return mintEffect(style);
      default:
        // GRID has no FISH counterpart: the DSL's grid is a layout a container
        // carries, not a named preset, so there is nothing to point at.
        unsupported.push({ id: style.id, name: styleName(style), styleType: style.styleType ?? "UNKNOWN" });
        return undefined;
    }
  };

  return {
    get styles(): DesignStyle[] {
      return minted;
    },
    get links(): number {
      return links;
    },
    unsupported,
    link: (figmaStyleId) => {
      if (!figmaStyleId || failed.has(figmaStyleId)) return undefined;
      let fishId = byFigmaId.get(figmaStyleId);
      if (!fishId) {
        const def = byId.get(figmaStyleId);
        if (!def) return undefined;
        fishId = mint(def);
        if (!fishId) {
          // Recorded once, not once per layer: the same unsupported style on a
          // hundred layers is one gap, and a report is read, not scrolled.
          failed.add(figmaStyleId);
          return undefined;
        }
        // Under BOTH names: the plugin points with ids and REST with keys, and a
        // layer from either door has to reach the same style.
        byFigmaId.set(def.id, fishId);
        if (def.key) byFigmaId.set(def.key, fishId);
      }
      links += 1;
      return fishId;
    }
  };
}

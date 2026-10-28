import type { Effect, LiquidGlassEffect } from "../types";
import { LIQUID_GLASS_DEFAULTS, clampGlassParam } from "../liquid-glass";
import { asBoolean, asNumber, isPlainObject, pxLength, type NormalizationRepair } from "./shared";
import { readBlendMode } from "./blend-mode";
import { parseBoxShadows, type ParsedShadow } from "../../import/css-values";
import { normalizeTear } from "./tear";

/**
 * The token links an effect carries: a colour token for its `color`, and a
 * binding per numeric field. `syncDualStorage` repaints and re-measures an effect
 * from these, so an effect that loses them keeps the values it was authored with
 * and stops following its mode.
 */
function effectTokens(raw: Record<string, unknown>): { tokenId?: string; tokenBindings?: Record<string, string> } {
  const tokenId = typeof raw.tokenId === "string" && raw.tokenId ? raw.tokenId : undefined;
  const bindings: Record<string, string> = {};
  if (isPlainObject(raw.tokenBindings)) {
    for (const [prop, id] of Object.entries(raw.tokenBindings as Record<string, unknown>)) {
      if (typeof id === "string" && id) bindings[prop] = id;
    }
  }
  return {
    ...(tokenId ? { tokenId } : {}),
    ...(Object.keys(bindings).length > 0 ? { tokenBindings: bindings } : {})
  };
}

/**
 * A text shadow, as a drop shadow.
 *
 * There is one shadow in the model. `text-shadow` used to be its own type and
 * its own branch, which meant two vocabularies for one paint and two places to
 * keep in step; a text element already renders a drop shadow as a CSS
 * `text-shadow` because the glyphs are the shape it casts, so the type only
 * said what the renderer could see for itself. The alias is still accepted and
 * the fold is reported, because a document that asked for a text shadow and got
 * a drop shadow should be able to read why.
 *
 * `spread` is dropped rather than carried: CSS `text-shadow` has no spread term,
 * so a value here could never be painted.
 */
export function textShadowFrom(raw: unknown): Effect | undefined {
  const effect = dropShadowFrom(raw);
  if (!effect) return undefined;
  const { spread: _unpaintable, ...rest } = effect as Effect & { spread?: number };
  return rest as Effect;
}

export function dropShadowFrom(raw: unknown): Effect | undefined {
  if (!isPlainObject(raw)) return undefined;
  const spread = asNumber(raw.spread);
  // A canonical effect carries `offset: { x, y }`; the model's own spellings use
  // offsetX/offsetY (or a bare x/y). Both must round-trip, otherwise re-running
  // normalization on an already-canonical document would zero the offsets.
  const offset = isPlainObject(raw.offset) ? raw.offset : undefined;
  const blendMode = readBlendMode(raw).mode;
  return {
    type: "drop-shadow",
    color: (typeof raw.color === "string" && raw.color) || "rgba(0,0,0,0.25)",
    offset: {
      x: pxLength(raw.offsetX ?? raw.x ?? offset?.x) ?? 0,
      y: pxLength(raw.offsetY ?? raw.y ?? offset?.y) ?? 0
    },
    blur: Math.max(0, pxLength(raw.blur) ?? 0),
    ...(spread !== undefined ? { spread } : {}),
    ...(blendMode && blendMode !== "normal" ? { blendMode } : {}),
    ...effectTokens(raw),
    enabled: asBoolean(raw.enabled) ?? true
  };
}

export function innerShadowFrom(raw: unknown): Effect | undefined {
  if (!isPlainObject(raw)) return undefined;
  const spread = asNumber(raw.spread);
  const offset = isPlainObject(raw.offset) ? raw.offset : undefined;
  const blendMode = readBlendMode(raw).mode;
  return {
    type: "inner-shadow",
    color: (typeof raw.color === "string" && raw.color) || "rgba(0,0,0,0.35)",
    offset: {
      x: pxLength(raw.offsetX ?? raw.x ?? offset?.x) ?? 0,
      y: pxLength(raw.offsetY ?? raw.y ?? offset?.y) ?? 0
    },
    blur: Math.max(0, pxLength(raw.blur) ?? 0),
    ...(spread !== undefined ? { spread } : {}),
    ...(blendMode && blendMode !== "normal" ? { blendMode } : {}),
    ...effectTokens(raw),
    enabled: asBoolean(raw.enabled) ?? true
  };
}

export function liquidGlassFrom(raw: unknown): LiquidGlassEffect | undefined {
  if (!isPlainObject(raw)) return undefined;
  const p = LIQUID_GLASS_DEFAULTS;
  return {
    type: "liquid-glass",
    frost: clampGlassParam("frost", asNumber(raw.frost) ?? p.frost),
    refraction: clampGlassParam("refraction", asNumber(raw.refraction) ?? p.refraction),
    depth: clampGlassParam("depth", asNumber(raw.depth) ?? p.depth),
    dispersion: clampGlassParam("dispersion", asNumber(raw.dispersion) ?? p.dispersion),
    lightAngle: clampGlassParam("lightAngle", asNumber(raw.lightAngle) ?? p.lightAngle),
    lightIntensity: clampGlassParam("lightIntensity", asNumber(raw.lightIntensity) ?? p.lightIntensity),
    splay: clampGlassParam("splay", asNumber(raw.splay) ?? p.splay),
    ...effectTokens(raw),
    enabled: asBoolean(raw.enabled) ?? true
  };
}

/** Keeps only structurally valid canonical effects. */
export function normalizeEffects(
  raw: unknown,
  path?: string,
  repairs?: NormalizationRepair[]
): Effect[] {
  if (!Array.isArray(raw)) return [];
  const out: Effect[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) continue;
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    if (type === "text-shadow") {
      const effect = textShadowFrom(item);
      if (effect) out.push(effect);
      repairs?.push({
        kind: "effect",
        path: `${path ?? ""}/effects/${index}/type`,
        severity: "info",
        message: '"text-shadow" normalized to "drop-shadow" (one shadow; a text paints it through its glyphs)'
      });
    } else if (type === "drop-shadow") {
      const effect = dropShadowFrom(item);
      if (effect) out.push(effect);
    } else if (type === "inner-shadow") {
      const effect = innerShadowFrom(item);
      if (effect) out.push(effect);
    } else if (type === "layer-blur") {
      out.push({
        type: "layer-blur",
        blur: Math.max(0, pxLength(item.blur) ?? 0),
        ...effectTokens(item),
        enabled: asBoolean(item.enabled) ?? true
      });
    } else if (type === "backdrop-blur") {
      out.push({
        type: "backdrop-blur",
        blur: Math.max(0, pxLength(item.blur) ?? 0),
        ...effectTokens(item),
        enabled: asBoolean(item.enabled) ?? true
      });
    } else if (type === "liquid-glass") {
      const effect = liquidGlassFrom(item);
      if (effect) out.push(effect);
    } else if (type === "tear" || type === "edge" || type === "torn-edge") {
      const effect = normalizeTear(item);
      if (effect) out.push(effect);
      // Two retired names fold onto `tear`, the same way `text-shadow` folded
      // onto `drop-shadow`: accepted, folded, and reported, so a document that
      // used either can read why the type moved.
      if (type !== "tear") {
        repairs?.push({
          kind: "effect",
          path: `${path ?? ""}/effects/${index}/type`,
          severity: "info",
          message: `"${type}" normalized to "tear" (one geometry effect; which break it is lives in \`profile\`, and whether it is an edge, a hole or a scrap lives in \`form\`)`
        });
      }
    }
  }
  return out;
}

/**
 * A CSS `box-shadow` value as a FISH effect. `inset` maps to `inner-shadow`;
 * everything else is a `drop-shadow`. Mirrors `dropShadowFrom` / `innerShadowFrom`
 * so both paths produce identical objects.
 */
export function shadowToEffect(sh: ParsedShadow): Effect {
  return {
    type: sh.inset ? "inner-shadow" : "drop-shadow",
    color: sh.color,
    offset: { x: sh.offsetX, y: sh.offsetY },
    blur: sh.blur,
    ...(sh.spread ? { spread: sh.spread } : {}),
    enabled: true
  };
}

/**
 * CSS `box-shadow` string → FISH effects[], stored bottom-first.
 *
 * The DSL's effect stack paints index 0 underneath and the last index on top,
 * which is the OPPOSITE of CSS: `box-shadow: A, B` puts A nearest the viewer.
 * So the parsed list (CSS order, first = front) is reversed before returning,
 * keeping the CSS front-most shadow at the end of the array.
 */
export function normalizeBoxShadow(raw: unknown): Effect[] | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "none") return undefined;
  const shadows = parseBoxShadows(trimmed);
  if (shadows.length === 0) return undefined;
  return shadows.reverse().map(shadowToEffect);
}

/**
 * CSS `text-shadow` string → the same drop-shadow stack, stored bottom-first.
 *
 * Same syntax as `box-shadow` minus `inset` and spread, which is why it goes
 * through the same parser: a text shadow IS a drop shadow here, and the only
 * difference the model keeps is the element type that paints it.
 */
export function normalizeTextShadow(raw: unknown): Effect[] | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "none") return undefined;
  const shadows = parseBoxShadows(trimmed).filter((sh) => !sh.inset);
  if (shadows.length === 0) return undefined;
  return shadows.reverse().map(shadowToEffect);
}

/**
 * Move a `style.textShadow` string into the effect stack it belongs in.
 *
 * A value nothing could parse is KEPT rather than dropped: it still reaches the
 * renderer's CSS fallback, and deleting an author's string because our parser
 * shrugged is the one outcome worse than carrying a second spelling.
 */
export function takeTextShadow<T extends { textShadow?: string }>(
  style: T
): { style: T; effects: Effect[] } {
  const effects = normalizeTextShadow(style.textShadow);
  if (!effects) return { style, effects: [] };
  const { textShadow: _alias, ...rest } = style;
  return { style: rest as T, effects };
}

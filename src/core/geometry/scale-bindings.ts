import { DesignElement, Effect } from "../dsl/types";

/**
 * What a scale moved, per family of pixel measurements.
 *
 * `true` means the numbers that family owns no longer match the shared style or
 * number token they came from — which is exactly what a scale does, because it
 * rewrites those numbers and nothing else.
 */
export interface ScaledProperties {
  /** Type size, leading and tracking. */
  text?: boolean;
  stroke?: boolean;
  effect?: boolean;
  /** Corner radii. */
  radius?: boolean;
  /** Auto-layout padding and gaps. */
  spacing?: boolean;
}

/**
 * The token-binding keys each family owns. A bound length is a POINTER to one
 * value on one token, so leaving it in place after a scale re-points the layer at
 * the 1x number on the next `syncDualStorage` — the scaled box comes back with its
 * original type size, radius, stroke and shadow, and the only visible symptom is
 * artwork that no longer fits its own frame.
 */
const TEXT_BINDINGS = ["fontSize", "lineHeight", "letterSpacing"] as const;
const STROKE_BINDINGS = ["strokeWidth"] as const;
const RADIUS_BINDINGS = [
  "borderRadius",
  // Both spellings of the same four corners — `CORNER_SLOTS` in
  // `core/interactions/number-token-ops.ts` reads them interchangeably.
  "topLeftRadius",
  "borderTopLeftRadius",
  "topRightRadius",
  "borderTopRightRadius",
  "bottomRightRadius",
  "borderBottomRightRadius",
  "bottomLeftRadius",
  "borderBottomLeftRadius"
] as const;
const SPACING_BINDINGS = [
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "gap",
  "columnGap",
  "rowGap"
] as const;
/** The per-effect bound lengths. The colour (`tokenId`) is not one of them. */
const EFFECT_BINDINGS = ["blur", "spread", "offsetX", "offsetY", "offset.x", "offset.y"] as const;

/** Writes a key OUT rather than to `undefined`: the DSL declares these absent, not null. */
function unset<T extends object>(el: T, key: string): T {
  const out = { ...el } as Record<string, unknown>;
  delete out[key];
  return out as T;
}

function withoutKeys(
  bindings: Record<string, string> | undefined,
  drop: readonly string[]
): Record<string, string> | undefined {
  if (!bindings) return bindings;
  const out = { ...bindings };
  let changed = false;
  for (const key of drop) {
    if (key in out) {
      delete out[key];
      changed = true;
    }
  }
  if (!changed) return bindings;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Rebinds every effect's LENGTH keys, keeping its colour token. */
function releaseEffects(effects: Effect[]): Effect[] {
  let changed = false;
  const next = effects.map((ef) => {
    const bindings = withoutKeys(ef.tokenBindings, EFFECT_BINDINGS);
    if (bindings === ef.tokenBindings) return ef;
    changed = true;
    return bindings === undefined
      ? unset({ ...ef }, "tokenBindings")
      : ({ ...ef, tokenBindings: bindings } as Effect);
  });
  return changed ? next : effects;
}

/**
 * Unbinds the shared styles and number tokens a scale has made stale, and keeps
 * every COLOUR binding: a fill, stroke colour or shadow tint is a material, not a
 * measurement, so a scaled component still has to answer Light / Dark.
 *
 * Leaving the bindings in place is what made a scaled Master render correctly and
 * its instance render wrong: the Master paints `el.style` straight off the
 * element, while an instance resolves through `syncDualStorage`, which
 * re-materialises whatever the binding points at. The two disagreed by exactly
 * the scale factor — 44px type in a 0.78x text box, folded into three lines.
 *
 * Returns the same element when nothing was bound, so an unbound scale keeps its
 * structural sharing.
 */
export function releaseScaledBindings<T extends DesignElement>(el: T, scaled: ScaledProperties): T {
  let next = el as DesignElement;

  const drop: string[] = [];
  if (scaled.text) {
    drop.push(...TEXT_BINDINGS);
    // Only a text carries one, and `null` already means "this text was detached".
    if ((next as { textStyleId?: string | null }).textStyleId) next = unset(next, "textStyleId");
  }
  if (scaled.stroke) {
    drop.push(...STROKE_BINDINGS);
    if (next.strokeStyleId) next = unset(next, "strokeStyleId");
  }
  if (scaled.radius) drop.push(...RADIUS_BINDINGS);
  if (scaled.spacing) drop.push(...SPACING_BINDINGS);

  if (drop.length > 0) {
    const bindings = withoutKeys(next.tokenBindings, drop);
    if (bindings !== next.tokenBindings) {
      next = bindings === undefined ? unset(next, "tokenBindings") : { ...next, tokenBindings: bindings };
    }
  }

  if (scaled.effect && next.effects && next.effects.length > 0) {
    const effects = releaseEffects(next.effects);
    if (effects !== next.effects) next = { ...next, effects };
    if (next.effectStyleId) next = unset(next, "effectStyleId");
  }

  return next as T;
}

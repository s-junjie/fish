import {
  ColorToken,
  ComponentOverride,
  CornerRadius,
  DesignElement,
  DesignStyle,
  DesignToken,
  Effect,
  InstanceElement,
  NumberToken,
  OverridableProperty,
  Paint,
  PaintStack,
  PaintStyle,
  Stroke,
  TextElement,
  TextStyleDefinition
} from "../dsl/types";
import { colorTokenValue, numberTokenValue, StyleTables, styleMap, tokenMap } from "./style-tables";
import { CORNER_SLOTS, numberTokenPropValue } from "./number-token-ops";
import { topPaint } from "../dsl/paint-stack";
import { materializeStopTokens, withGradientEndpoints } from "../dsl/gradient-stops";
import { composeColorAlpha, parseColorAlpha } from "../geometry/color-utils";
import { parseCornerRadii } from "../geometry/rounded-box";
import { isContainer } from "../geometry/tree-ops";

/**
 * The materialised half of a paint's token bindings: a solid's own `tokenId`,
 * and every gradient stop's. `from` / `to` follow the stops they mirror, or a
 * reader that rebuilds the ramp from them paints the pre-token colours.
 */
function materializePaintTokens(
  paint: Paint,
  resolve: (tokenId: string) => string | undefined
): Paint {
  if (paint.type === "solid") {
    if (!paint.tokenId) return paint;
    const color = resolve(paint.tokenId);
    return color && color !== paint.color ? { ...paint, color } : paint;
  }
  const stops = "stops" in paint ? paint.stops : undefined;
  if (!stops?.some((stop) => stop.tokenId)) return paint;
  const materialized = materializeStopTokens(stops, resolve);
  if (!materialized) return paint;
  const ramp = paint as Paint & { from?: string; to?: string };
  return { ...withGradientEndpoints(ramp, materialized), stops: materialized } as Paint;
}

/**
 * Resolves a PaintStyle's paint stack.
 *
 * A style no longer carries per-mode stacks: the difference between modes lives
 * on the TOKENS its paints reference (`paint.tokenId`), and `cascadeTokensIntoStyles`
 * writes that difference into the style before this is read. There is therefore
 * no theme input to take — a `theme` parameter would say there is.
 */
export function resolvePaintStylePaints(style: PaintStyle): PaintStack {
  return style.paints;
}

/** Resolves the hex of a Color Token for the given colour mode. */
export function resolveColorTokenHex(token: ColorToken, activeTheme?: string): string {
  return colorTokenValue(token, activeTheme);
}

/** Resolves the numeric value of a Number Token for the given number mode. */
export function resolveNumberTokenVal(token: NumberToken, activeNumberMode?: string): number {
  return numberTokenValue(token, activeNumberMode);
}

/**
 * A shadow stack's token links, materialised.
 *
 * One walker for the two tables that carry effects: an effect STYLE and a
 * layer. A text style deliberately has none (a text style is type only).
 */
function cascadeEffectTokens(
  effects: readonly Effect[],
  colorMap: Map<string, string>,
  numberMap: Map<string, number>
): { effects: Effect[]; changed: boolean } {
  let changed = false;
  const nextEffects = effects.map((ef) => {
    let efChanged = false;
    let nextEf: any = ef;
    const tid = (ef as any).tokenId as string | undefined;
    if (tid && colorMap.has(tid) && "color" in ef && (ef as any).color !== colorMap.get(tid)) {
      nextEf = { ...nextEf, color: colorMap.get(tid)! };
      efChanged = true;
    }
    const b = ef.tokenBindings;
    if (b) {
      for (const [prop, boundId] of Object.entries(b)) {
        if (!numberMap.has(boundId)) continue;
        const v = numberMap.get(boundId)!;
        if ((prop === "blur" || prop === "spread") && nextEf[prop] !== v) {
          nextEf = { ...nextEf, [prop]: v };
          efChanged = true;
        } else if (prop === "offsetX" || prop === "offset.x") {
          if (nextEf.offset?.x !== v) {
            nextEf = { ...nextEf, offset: { ...(nextEf.offset || {}), x: v } };
            efChanged = true;
          }
        } else if (prop === "offsetY" || prop === "offset.y") {
          if (nextEf.offset?.y !== v) {
            nextEf = { ...nextEf, offset: { ...(nextEf.offset || {}), y: v } };
            efChanged = true;
          }
        }
      }
    }
    if (efChanged) changed = true;
    return efChanged ? (nextEf as Effect) : ef;
  });
  return { effects: nextEffects, changed };
}

/**
 * Cascades color and number token values into composite styles (`paint`, `stroke`, `text`, `effect`).
 *
 * The two axes are resolved independently: a colour style answers to `activeTheme`,
 * a text style's type sizes to `activeNumberMode`. When no number mode is handed
 * in, the colour mode is used as the fallback so a caller that only ever knew one
 * axis keeps resolving exactly as before.
 * When `filterTokenId` is provided, only references to that token are updated.
 */
export function cascadeTokensIntoStyles(
  styles: readonly DesignStyle[],
  tokens: readonly DesignToken[],
  activeTheme?: string,
  filterTokenId?: string,
  activeNumberMode?: string
): DesignStyle[] {
  const colorMap = new Map<string, string>();
  const numberMap = new Map<string, number>();
  const numberMode = activeNumberMode ?? activeTheme;

  for (const token of tokens) {
    if (filterTokenId && token.id !== filterTokenId) continue;
    if (token.type === "color") colorMap.set(token.id, resolveColorTokenHex(token, activeTheme));
    else numberMap.set(token.id, resolveNumberTokenVal(token, numberMode));
  }

  if (colorMap.size === 0 && numberMap.size === 0) return styles.slice();

  return styles.map((s): DesignStyle => {
    if (s.styleType === "paint") {
      const paints = s.paints ?? [];
      const next = paints.map((p) => materializePaintTokens(p, (id) => colorMap.get(id)));
      if (next.some((p, i) => p !== paints[i])) return { ...s, paints: next };
    } else if (s.styleType === "stroke") {
      if (
        s.strokes?.some((st) => {
          const tid = st.tokenId ?? st.paint?.tokenId;
          return tid !== undefined && colorMap.has(tid);
        })
      ) {
        return {
          ...s,
          strokes: s.strokes.map((st) => {
            const tid = st.tokenId ?? st.paint?.tokenId;
            if (!tid || !colorMap.has(tid)) return st;
            const c = colorMap.get(tid)!;
            return {
              ...st,
              color: c,
              ...(st.paint?.type === "solid" ? { paint: { ...st.paint, color: c } } : {})
            };
          })
        };
      }
    } else if (s.styleType === "text") {
      let next: TextStyleDefinition = s;
      let textChanged = false;
      if (s.style?.tokenBindings) {
        const nextStyle: any = { ...s.style };
        for (const [prop, boundId] of Object.entries(s.style.tokenBindings)) {
          const v = numberMap.get(boundId);
          if (v !== undefined && nextStyle[prop] !== numberTokenPropValue(prop, v)) {
            nextStyle[prop] = numberTokenPropValue(prop, v);
            textChanged = true;
          }
        }
        if (textChanged) next = { ...next, style: nextStyle };
      }
      return next;
    } else if (s.styleType === "effect" && s.effects?.length) {
      const cascaded = cascadeEffectTokens(s.effects, colorMap, numberMap);
      if (cascaded.changed) return { ...s, effects: cascaded.effects };
    }
    return s;
  });
}

/**
 * Refreshes the override VALUES that a node's numeric token bindings stand for.
 *
 * A binding is a pointer (a token id), so switching modes cannot change it — but
 * the stored number beside it (`borderRadius`, a stroke width, a type size) was
 * written for the mode the user bound in, and the resolver applies that number
 * AFTER the binding materialises. Left alone it wins, and a radius token bound on
 * an instance child comes back as whatever the light theme said.
 *
 * Only entries that already exist are touched: inventing one here would mean
 * guessing the values of the axes this binding says nothing about (the other
 * three corners), and an override that guesses is worse than one that waits for
 * the edit that creates it.
 */
function syncBindingValues(
  overrides: ComponentOverride[],
  targetId: string,
  bindings: Record<string, string>,
  numberValue: (tokenId: string) => number | undefined
): boolean {
  const slotOf = (property: ComponentOverride["property"]): number => overrides.findIndex(
    (o) => o.targetId === targetId && o.property === property
  );
  let changed = false;

  const write = (idx: number, value: unknown) => {
    overrides[idx] = { ...overrides[idx], value };
    changed = true;
  };

  for (const [prop, tokenId] of Object.entries(bindings)) {
    const v = numberValue(tokenId);
    if (v === undefined) continue;

    const corner = CORNER_SLOTS[prop];
    if (corner !== undefined || prop === "borderRadius") {
      const idx = slotOf("borderRadius");
      if (idx < 0) continue;
      const stored = overrides[idx].value;
      if (corner === undefined) {
        const next = Array.isArray(stored) ? [v, v, v, v] : v;
        if (!sameValue(next, stored)) write(idx, next);
        continue;
      }
      const radii = [...parseCornerRadii(stored as CornerRadius | undefined)] as [number, number, number, number];
      if (radii[corner] === v) continue;
      radii[corner] = v;
      write(idx, radii);
      continue;
    }

    const strokesIdx = prop === "strokeWidth" ? slotOf("strokes") : -1;
    if (strokesIdx >= 0 && Array.isArray(overrides[strokesIdx].value)) {
      const rows = overrides[strokesIdx].value as Stroke[];
      if (rows.some((row) => row.width !== v)) {
        write(strokesIdx, rows.map((row) => ({ ...row, width: v })));
      }
      continue;
    }

    if (prop === "fontSize" || prop === "lineHeight" || prop === "letterSpacing") {
      const idx = slotOf("style");
      if (idx < 0) continue;
      const bag = overrides[idx].value;
      // Only an axis this override already owns: the rest still follow the
      // master, and adding one here would pin it.
      if (typeof bag !== "object" || bag === null || !(prop in (bag as object))) continue;
      const value = numberTokenPropValue(prop, v);
      if ((bag as Record<string, unknown>)[prop] === value) continue;
      write(idx, { ...(bag as object), [prop]: value });
    }
  }
  return changed;
}

/** Structural equality for the small value trees a sync rewrites. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A copy of a style's declarations that the element can own.
 *
 * The declarations are plain data, and the element must not share their arrays
 * with the style. `JSON.parse(JSON.stringify(…))` achieved that by stringifying
 * every paint and shadow of every element wearing the style — measured as most
 * of what a normalize spent. This copies the same data in one pass.
 */
function cloneDeclarations<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneDeclarations) as unknown as T;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) out[key] = cloneDeclarations(source[key]);
    return out as T;
  }
  return value;
}

const STYLE_PROP_MAP: Record<string, { prop: OverridableProperty; read: (s: any, theme?: string) => any }> = {
  fillStyleId: { prop: "fills", read: (s) => s.styleType === "paint" && resolvePaintStylePaints(s) },
  strokeStyleId: { prop: "strokes", read: (s) => s.styleType === "stroke" && s.strokes },
  effectStyleId: { prop: "effects", read: (s) => s.styleType === "effect" && s.effects }
};

/**
 * Ensures the Dual-Storage Invariant: elements and instances carrying style or token
 * bindings keep their evaluated local styling properties strictly in sync with their
 * referenced styles and tokens for the active modes.
 *
 * Two axes, two effective modes: `fills` / `strokes` / `effects[].tokenId` resolve
 * against the colour mode, `tokenBindings` and `effects[].tokenBindings` against the
 * number mode. `activeNumberMode` falling back to `activeTheme` keeps a one-axis
 * caller (and every pre-split document) resolving as it always did.
 */
export function syncDualStorage(
  element: DesignElement,
  tables: StyleTables,
  activeTheme?: string,
  activeNumberMode?: string
): DesignElement {
  const stylesById = styleMap(tables.styles);
  const tokensById = tokenMap(tables.tokens);
  let next = element;
  let changed = false;
  const effectiveTheme = (element as any).themeMode || activeTheme;
  const effectiveNumberMode = (element as any).numberMode || activeNumberMode || effectiveTheme;

  if (next.fillStyleId && stylesById.has(next.fillStyleId)) {
    const style = stylesById.get(next.fillStyleId)!;
    if (style.styleType === "paint") {
      next = { ...next, fills: cloneDeclarations(resolvePaintStylePaints(style)) };
      changed = true;
    }
  }

  if (
    next.type === "text" &&
    (next as TextElement).textStyleId &&
    stylesById.has((next as TextElement).textStyleId!)
  ) {
    const style = stylesById.get((next as TextElement).textStyleId!)!;
    if (style.styleType === "text") {
      const textEl = next as TextElement;
      next = {
        ...textEl,
        style: {
          ...(textEl.style || {}),
          ...style.style
        }
      };
      changed = true;
    }
  }

  const resolveColorToken = (tokenId: string): string | undefined => {
    const token = tokensById.get(tokenId);
    return token?.type === "color" ? resolveColorTokenHex(token, effectiveTheme) : undefined;
  };

  if (next.fills?.length) {
    let fillsChanged = false;
    const fills = next.fills.map((paint) => {
      const materialized = materializePaintTokens(paint, resolveColorToken);
      if (materialized !== paint) fillsChanged = true;
      return materialized;
    });
    if (fillsChanged) {
      next = { ...next, fills };
      changed = true;
    }
  }

  // A stroke style owns the whole stack. Only a STROKE style can: the four style
  // kinds are independent, so `strokeStyleId` never resolves against a paint
  // style (that would make a fill style own a stroke's declaration).
  if (next.strokeStyleId && stylesById.has(next.strokeStyleId)) {
    const style = stylesById.get(next.strokeStyleId)!;
    if (style.styleType === "stroke") {
      next = { ...next, strokes: cloneDeclarations(style.strokes) };
      changed = true;
    }
  }

  // Rows that follow a colour token are part of the same invariant.
  if (next.strokes?.length) {
    let rowsChanged = false;
    const strokes = next.strokes.map((s) => {
      // A row's colour source is a VALUE and the TOKEN it follows (`tokenId`, or
      // the same id on a nested solid `paint`). There is no style pointer here.
      const tokenId = s.tokenId ?? (s.paint?.type === "solid" ? s.paint.tokenId : undefined);
      if (tokenId) {
        const token = tokensById.get(tokenId);
        if (!token || token.type !== "color") return s;
        const color = resolveColorTokenHex(token, effectiveTheme);
        if (s.color === color) return s;
        rowsChanged = true;
        return { ...s, color };
      }
      // A stroke may carry a gradient of its own, whose stops follow tokens the
      // same way a fill's do.
      if (s.paint) {
        const materialized = materializePaintTokens(s.paint, resolveColorToken);
        if (materialized === s.paint) return s;
        rowsChanged = true;
        return { ...s, paint: materialized };
      }
      return s;
    });
    if (rowsChanged) {
      next = { ...next, strokes };
      changed = true;
    }
  }

  if (next.effectStyleId && stylesById.has(next.effectStyleId)) {
    const style = stylesById.get(next.effectStyleId)!;
    if (style.styleType === "effect") {
      next = { ...next, effects: cloneDeclarations(style.effects) };
      changed = true;
    }
  }

  if (next.effects?.length) {
    let effectsChanged = false;
    const effects = next.effects.map((ef) => {
      let efChanged = false;
      let nextEf: any = ef;
      if (nextEf.tokenId) {
        const token = tokensById.get(nextEf.tokenId);
        if (token?.type === "color" && "color" in nextEf) {
          const targetColor = resolveColorTokenHex(token, effectiveTheme);
          if (nextEf.color !== targetColor) {
            nextEf = { ...nextEf, color: targetColor };
            efChanged = true;
          }
        }
      }
      if (nextEf.tokenBindings) {
        const bindings = nextEf.tokenBindings as Record<string, string>;
        for (const [prop, boundId] of Object.entries(bindings)) {
          const tok = tokensById.get(boundId);
          if (tok && tok.type === "number") {
            const v = resolveNumberTokenVal(tok, effectiveNumberMode);
            if ((prop === "blur" || prop === "spread") && nextEf[prop] !== v) {
              nextEf = { ...nextEf, [prop]: v };
              efChanged = true;
            } else if (prop === "offsetX" || prop === "offset.x") {
              if (nextEf.offset?.x !== v) {
                nextEf = { ...nextEf, offset: { ...(nextEf.offset || {}), x: v } };
                efChanged = true;
              }
            } else if (prop === "offsetY" || prop === "offset.y") {
              if (nextEf.offset?.y !== v) {
                nextEf = { ...nextEf, offset: { ...(nextEf.offset || {}), y: v } };
                efChanged = true;
              }
            } else if (nextEf[prop] !== v) {
              nextEf = { ...nextEf, [prop]: v };
              efChanged = true;
            }
          }
        }
      }
      if (efChanged) {
        effectsChanged = true;
        return nextEf;
      }
      return ef;
    });
    if (effectsChanged) {
      next = { ...next, effects };
      changed = true;
    }
  }

  if (next.tokenBindings) {
    let numBindingsChanged = false;
    const updatedEl: any = { ...next };
    for (const [prop, boundId] of Object.entries(next.tokenBindings)) {
      const tok = tokensById.get(boundId);
      if (tok && tok.type === "number") {
        const v = resolveNumberTokenVal(tok, effectiveNumberMode);
        const cornerSlot = CORNER_SLOTS[prop];
        if (cornerSlot !== undefined) {
          const currentRadii = parseCornerRadii(updatedEl.borderRadius);
          const nextRadii = [...currentRadii] as [number, number, number, number];
          if (nextRadii[cornerSlot] !== v) {
            nextRadii[cornerSlot] = v;
            updatedEl.borderRadius = nextRadii;
            numBindingsChanged = true;
          }
        } else if (prop === "borderRadius" || prop === "padding") {
          updatedEl[prop] = Array.isArray(updatedEl[prop]) ? [v, v, v, v] : v;
          numBindingsChanged = true;
        } else if (prop === "strokeWidth") {
          if (Array.isArray(updatedEl.strokes)) {
            updatedEl.strokes = updatedEl.strokes.map((s: any) => ({ ...s, width: v }));
            numBindingsChanged = true;
          }
        } else if (prop === "fontSize" || prop === "lineHeight" || prop === "letterSpacing") {
          updatedEl.style = { ...(updatedEl.style || {}), [prop]: numberTokenPropValue(prop, v) };
          numBindingsChanged = true;
        } else {
          updatedEl[prop] = v;
          numBindingsChanged = true;
        }
      }
    }
    if (numBindingsChanged) {
      next = updatedEl as DesignElement;
      changed = true;
    }
  }

  if (next.type === "instance") {
    const inst = next as InstanceElement;
    if (Array.isArray(inst.overrides) && inst.overrides.length > 0) {
      let ovChanged = false;
      const nextOverrides = [...inst.overrides];
      // Built on demand, once: an instance with no token-bearing override pays
      // nothing, and one with several pays one walk of the token table.
      let colorValues: Map<string, string> | null = null;
      let numberValues: Map<string, number> | null = null;
      const colors = () => {
        if (!colorValues) {
          colorValues = new Map();
          for (const token of tokensById.values()) {
            if (token.type === "color") colorValues.set(token.id, resolveColorTokenHex(token, effectiveTheme));
          }
        }
        return colorValues;
      };
      const numbers = () => {
        if (!numberValues) {
          numberValues = new Map();
          for (const token of tokensById.values()) {
            if (token.type === "number") numberValues.set(token.id, resolveNumberTokenVal(token, effectiveNumberMode));
          }
        }
        return numberValues;
      };
      for (let i = 0; i < inst.overrides.length; i++) {
        const ov = inst.overrides[i];
        const mapping = typeof ov.value === "string" ? STYLE_PROP_MAP[ov.property] : undefined;
        if (mapping && stylesById.has(ov.value as string)) {
          const val = mapping.read(stylesById.get(ov.value as string), effectiveTheme);
          if (val) {
            const idx = nextOverrides.findIndex((o) => o.targetId === ov.targetId && o.property === mapping.prop);
            const cloned = cloneDeclarations(val);
            if (idx >= 0) nextOverrides[idx] = { ...nextOverrides[idx], value: cloned };
            else nextOverrides.push({ targetId: ov.targetId, property: mapping.prop, value: cloned });
            ovChanged = true;
          }
        }
        // An override carrying a TOKEN has to answer the mode the same way a
        // layer does. This used to read `fills` and only the solid's `tokenId`,
        // so an overridden stroke, shadow or gradient stop kept the colour it
        // was written with and the instance stayed light on a dark page.
        if (ov.property === "fills" && Array.isArray(ov.value)) {
          const stored = ov.value as Paint[];
          const paints = stored.map((paint) => materializePaintTokens(paint, (id) => colors().get(id)));
          if (paints.some((paint, p) => paint !== stored[p])) {
            nextOverrides[i] = { ...ov, value: paints };
            ovChanged = true;
          }
        } else if (ov.property === "strokes" && Array.isArray(ov.value)) {
          const stored = ov.value as Stroke[];
          const strokes = stored.map((stroke) => {
            const tokenId = stroke.tokenId ?? (stroke.paint?.type === "solid" ? stroke.paint.tokenId : undefined);
            if (tokenId) {
              const color = colors().get(tokenId);
              if (color && color !== stroke.color) return { ...stroke, color };
              return stroke;
            }
            if (!stroke.paint) return stroke;
            const paint = materializePaintTokens(stroke.paint, (id) => colors().get(id));
            return paint === stroke.paint ? stroke : { ...stroke, paint };
          });
          if (strokes.some((stroke, s) => stroke !== stored[s])) {
            nextOverrides[i] = { ...ov, value: strokes };
            ovChanged = true;
          }
        } else if (ov.property === "effects" && Array.isArray(ov.value)) {
          const cascaded = cascadeEffectTokens(ov.value as Effect[], colors(), numbers());
          if (cascaded.changed) {
            nextOverrides[i] = { ...ov, value: cascaded.effects };
            ovChanged = true;
          }
        } else if (ov.property === "tokenBindings" && ov.value && typeof ov.value === "object") {
          // The NUMBERS a binding stands for. The bindings themselves are
          // mode-independent (a token id), so what has to move is the value the
          // override beside them stores — otherwise a radius bound on an
          // instance child keeps the radius of the mode it was bound in.
          if (
            syncBindingValues(
              nextOverrides,
              ov.targetId,
              ov.value as Record<string, string>,
              (id) => numbers().get(id)
            )
          ) {
            ovChanged = true;
          }
        }
      }
      if (ovChanged) {
        next = { ...next, overrides: nextOverrides } as InstanceElement;
        changed = true;
      }
    }
  }

  if (isContainer(next) && next.children) {
    let childChanged = false;
    const updatedChildren = next.children.map((c) => {
      const res = syncDualStorage(c, tables, effectiveTheme, effectiveNumberMode);
      if (res !== c) childChanged = true;
      return res;
    });
    if (childChanged) {
      next = { ...next, children: updatedChildren };
      changed = true;
    }
  }

  return changed ? next : element;
}

/**
 * `$token` and `var(--name)` shorthands: an author (or an agent) writes the
 * token's name where a value belongs, and normalize turns it into the stored
 * pair the renderer reads — the reference AND the value, exactly as the
 * inspector's bind command writes them.
 *
 * Why this pass runs BEFORE `resolveValueTokens` over the raw document:
 * - Only the document carries `tokens[]` and mode maps, which decide which token
 *   a name refers to, whether its type matches the slot, and its active value.
 * - Running before `resolveValueTokens` lets whole-value `var(--name)` in a
 *   bindable slot bind live (`tokenId` / `tokenBindings`), while explicit
 *   `doc.variables` win first and compound `calc(... var(--name))` or
 *   unbindable slots fall back to `createTokenVarResolver`.
 */

import { numberModeOf, themeOf } from "../token-value";
import {
  bindNumberToken,
  CORNER_SLOTS,
  numberTokenPropValue,
  PADDING_SLOTS,
  withoutNumberBinding,
  writeNumberValue
} from "../token-bindings";
import { expandFourSides } from "./auto-layout";
import { cornerRadiusInput, parseBorderShorthand, parseRadiusString } from "./stroke";
import type { Variables } from "./resolve-values";
import { parseBoxShadows } from "../../import/css-values";
import { canonicalKey, isPlainObject, type NormalizationRepair } from "./shared";
import {
  buildTokenRefTable,
  colorOf,
  createTokenVarResolver,
  finishColorSlot,
  finishNumberSlot,
  lookupToken,
  numberOf,
  parseTokenRef,
  reportSlotError,
  resolveSlotRef,
  resolveTokenRef,
  type ShorthandModes,
  type TokenRefTable,
  type TokenSlotContext
} from "./token-var-bridge";

export {
  buildTokenRefTable,
  createTokenVarResolver,
  lookupToken,
  parseTokenRef,
  resolveTokenRef,
  type ShorthandModes,
  type TokenRefTable
};

/** Splits a CSS spacing string on whitespace outside `(...)` (matching `splitCssTokens`). */
function splitSpacingTokens(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(ch)) {
      if (i > start) parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (start < input.length) parts.push(input.slice(start));
  return parts;
}

// ---------------------------------------------------------------------------
// the slot tables
// ---------------------------------------------------------------------------

/**
 * Element-level colour aliases. `fills` already present wins, which is the
 * precedence `normalizeFillStack` applies today.
 */
const COLOR_ALIASES: ReadonlyArray<readonly [string, "fills"]> = [
  ["background-color", "fills"],
  ["background", "fills"],
  ["color", "fills"]
];

/** Paint stacks whose entries carry a colour of their own. */
const COLOR_STACKS: readonly string[] = ["fills", "strokes", "effects"];

/**
 * Number slots: the author's key (canonical, kebab) → the stored property name,
 * which is also the `tokenBindings` key. Only keys with a reader are here; the
 * per-side stroke weights (`border-top-width`, `strokeTopWeight`) are input
 * aliases folded into `strokes[].sides` during normalize, so a binding recorded
 * for them would be written and never read.
 */
const NUMBER_SLOTS: Readonly<Record<string, string>> = {
  gap: "gap",
  "row-gap": "row-gap",
  "column-gap": "column-gap",
  padding: "padding",
  width: "width",
  height: "height",
  "border-radius": "borderRadius",
  radius: "borderRadius",
  "corner-radius": "borderRadius",
  "border-top-left-radius": "borderTopLeftRadius",
  "border-top-right-radius": "borderTopRightRadius",
  "border-bottom-right-radius": "borderBottomRightRadius",
  "border-bottom-left-radius": "borderBottomLeftRadius",
  "stroke-width": "strokeWidth",
  "border-width": "strokeWidth",
  "font-size": "fontSize",
  "line-height": "lineHeight",
  "letter-spacing": "letterSpacing"
};

/** Type slots: read only on a text layer, which is decided by the element type. */
const TYPE_SLOTS: ReadonlySet<string> = new Set(["fontSize", "lineHeight", "letterSpacing"]);

/** Padding object side keys mapped to the stored 4-tuple binding names. */
const PADDING_SIDE_PROPS: Readonly<Record<string, string>> = {
  top: "paddingTop",
  t: "paddingTop",
  right: "paddingRight",
  r: "paddingRight",
  bottom: "paddingBottom",
  b: "paddingBottom",
  left: "paddingLeft",
  l: "paddingLeft"
};

const PADDING_TUPLE_BINDINGS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;

/** Slots that exist in CSS and in this dialect, but not as a token binding. */
const REFUSED_NUMBER_SLOTS: Readonly<Record<string, string>> = {
  "border-top-width": "a per-side stroke weight is an input alias; bind `strokeWidth`",
  "border-right-width": "a per-side stroke weight is an input alias; bind `strokeWidth`",
  "border-bottom-width": "a per-side stroke weight is an input alias; bind `strokeWidth`",
  "border-left-width": "a per-side stroke weight is an input alias; bind `strokeWidth`"
};

/**
 * Every key this pass reads, for the rigs: a slot added here without a case in
 * the table-driven test is a slot nothing grades (AGENTS.md §5.1 — the test
 * derives from this list, it does not restate it).
 */
export const TOKEN_SHORTHAND_KEYS = {
  color: [...COLOR_ALIASES.map(([key]) => key), "border-color", ...COLOR_STACKS],
  number: Object.keys(NUMBER_SLOTS)
} as const;

/** Author's key → the stored property (and `tokenBindings` key) it names. */
export const TOKEN_SHORTHAND_BINDINGS: Readonly<Record<string, string>> = NUMBER_SLOTS;

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

/** A paint, a stroke row or an effect: its own `color`, nested `paint`, plus a gradient's stops. */
function applyToPaint(
  entry: unknown,
  ctx: TokenSlotContext,
  path: string,
  repairs: NormalizationRepair[]
): unknown {
  if (typeof entry === "string") {
    const resolved = resolveSlotRef(entry, ctx.table, ctx.vars);
    if (!resolved) return entry;
    const applied = finishColorSlot(resolved, ctx, path, repairs);
    return applied ? { type: "solid", color: applied.color, tokenId: applied.token.id } : undefined;
  }
  if (!isPlainObject(entry)) return entry;

  let out: Record<string, unknown> | null = null;
  const edit = () => (out ??= { ...entry });

  const colorResolved = resolveSlotRef(entry.color, ctx.table, ctx.vars);
  if (colorResolved) {
    const applied = finishColorSlot(colorResolved, ctx, `${path}/color`, repairs);
    if (!applied) return undefined;
    edit().color = applied.color;
    edit().tokenId = applied.token.id;
  } else {
    // Only a row that stated NO new reference is re-materialised from its own
    // `tokenId`. Doing it unconditionally read the INPUT's id, so a row that
    // rebinds — `{ tokenId: "tok_old", color: "$new" }` — was bound to the new
    // token and had the old one written back a line later.
    const bound = lookupToken(entry.tokenId, ctx.table);
    if (bound) {
      const color = colorOf(bound, ctx);
      edit().tokenId = bound.id;
      if (color !== undefined) edit().color = color;
    }
  }

  if (isPlainObject(entry.paint)) {
    const rewrittenPaint = applyToPaint(entry.paint, ctx, `${path}/paint`, repairs);
    if (rewrittenPaint === undefined) return undefined;
    if (rewrittenPaint !== entry.paint) edit().paint = rewrittenPaint;
  }

  const stops = entry.stops;
  if (Array.isArray(stops) && stops.some((stop) => isPlainObject(stop) && resolveSlotRef(stop.color, ctx.table, ctx.vars))) {
    edit().stops = stops.map((stop, index) => {
      if (!isPlainObject(stop)) return stop;
      const resolved = resolveSlotRef(stop.color, ctx.table, ctx.vars);
      if (!resolved) return stop;
      const applied = finishColorSlot(resolved, ctx, `${path}/stops/${index}`, repairs);
      return applied ? { ...stop, color: applied.color, tokenId: applied.token.id } : stop;
    });
  }

  return out ?? entry;
}

/** One element: colour slots, number slots, existing references, then children. */
function applyToElement(
  el: Record<string, unknown>,
  ctx: TokenSlotContext,
  path: string,
  repairs: NormalizationRepair[]
): Record<string, unknown> {
  let out = el;
  const edit = () => (out === el ? (out = { ...el }) : out);

  // One canonicalisation per key for the whole element: `canonicalKey` is the
  // only string work this pass does per key, and three separate scans for the
  // colour aliases, the border colour and the number slots tripled it on every
  // element of every document that declares a token table.
  const byCanon = new Map<string, string>();
  for (const key of Object.keys(el)) {
    const canon = canonicalKey(key);
    if (!byCanon.has(canon)) byCanon.set(canon, key);
  }

  // --- the element's own mode override, inherited down its subtree ----------
  // `themeMode` is documented as "this container and its subtree" and `mode-ops`
  // walks it that way when a mode is edited, so the value written here has to
  // agree with what that walk would produce.
  const mode: TokenSlotContext =
    (typeof el.themeMode === "string" && el.themeMode) || (typeof el.numberMode === "string" && el.numberMode)
      ? {
          ...ctx,
          theme: typeof el.themeMode === "string" && el.themeMode ? el.themeMode : ctx.theme,
          numberMode: typeof el.numberMode === "string" && el.numberMode ? el.numberMode : ctx.numberMode
        }
      : ctx;

  // --- colour aliases -----------------------------------------------------
  for (const [key, target] of COLOR_ALIASES) {
    const own = byCanon.get(key);
    if (own === undefined) continue;
    const resolved = resolveSlotRef(el[own], mode.table, mode.vars);
    if (!resolved) continue;
    if (el.fills !== undefined) {
      repairs.push({
        kind: "token",
        path: `${path}/${own}`,
        message: `"${own}" ignored: fills is already set`
      });
      continue;
    }
    const applied = finishColorSlot(resolved, mode, `${path}/${own}`, repairs);
    if (!applied) {
      delete edit()[own];
      continue;
    }
    const draft = edit();
    delete draft[own];
    (draft as Record<string, unknown>)[target] = [{ type: "solid", color: applied.color, tokenId: applied.token.id }];
    break;
  }

  // --- border colour -----------------------------------------------------
  // `border` is the structured slot (`normalizeStroke` reads `border.tokenId`).
  // A string `border` is the CSS shorthand, which this pass does not rewrite:
  // merging a colour into it would silently drop the width and style it carries.
  const borderColorKey = byCanon.get("border-color");
  const borderColorResolved = borderColorKey ? resolveSlotRef(el[borderColorKey], mode.table, mode.vars) : null;
  if (borderColorKey && borderColorResolved) {
    if (el.border !== undefined) {
      repairs.push({
        kind: "token",
        path: `${path}/${borderColorKey}`,
        message: `"${borderColorKey}" ignored: border is already set (write the token there)`
      });
    } else {
      const applied = finishColorSlot(borderColorResolved, mode, `${path}/${borderColorKey}`, repairs);
      if (!applied) {
        delete edit()[borderColorKey];
      } else {
        const draft = edit();
        delete draft[borderColorKey];
        draft.border = { color: applied.color, tokenId: applied.token.id };
      }
    }
  }

  // --- `border` shorthand or structured border object --------------------
  // Split by the parser that already knows `<width> || <style> || <color>`, then
  // lowered onto the structured object `normalizeStroke` reads — so the width and
  // style the author wrote survive, which is the whole reason not to rewrite the
  // string in place.
  if (typeof el.border === "string") {
    const parsed = parseBorderShorthand(el.border);
    const resolved = parsed?.color ? resolveSlotRef(parsed.color, mode.table, mode.vars) : null;
    if (resolved) {
      const applied = finishColorSlot(resolved, mode, `${path}/border`, repairs);
      if (!applied) {
        delete edit().border;
      } else {
        edit().border = {
          ...(parsed!.width !== undefined ? { width: parsed!.width } : {}),
          ...(parsed!.style ? { style: parsed!.style } : {}),
          color: applied.color,
          tokenId: applied.token.id
        };
      }
    }
  } else if (isPlainObject(el.border)) {
    const rewritten = applyToPaint(el.border, mode, `${path}/border`, repairs);
    if (rewritten === undefined) delete edit().border;
    else if (rewritten !== el.border) edit().border = rewritten;
  }

  // A per-side shorthand shares ONE colour for the whole stroke, so a token
  // inside it cannot be attributed to a single side. Named and refused rather
  // than merged into `border`, which would silently move the width.
  for (const side of ["border-top", "border-right", "border-bottom", "border-left"]) {
    const value = el[side];
    if (typeof value !== "string") continue;
    const parsed = parseBorderShorthand(value);
    const ref = parsed?.color ? parseTokenRef(parsed.color) : null;
    if (!ref) continue;
    repairs.push({
      kind: "token",
      path: `${path}/${side}`,
      message: `"$${ref}" in "${side}" is not supported: one colour covers every side, so write it in "border"`
    });
  }

  // A shadow STRING is parsed into effects later (`effects.ts`), so the colour
  // token inside it has nowhere to land from here. Reported instead of left to
  // paint a shadow whose colour is the literal `$x`.
  if (typeof el.boxShadow === "string" && el.boxShadow.includes("$")) {
    const ref = parseBoxShadows(el.boxShadow)
      .map((shadow) => parseTokenRef(shadow.color))
      .find((candidate): candidate is string => Boolean(candidate));
    if (ref) {
      repairs.push({
        kind: "token",
        path: `${path}/boxShadow`,
        message: `"$${ref}" in "boxShadow" is not supported: write the shadow as an effects[] entry that carries both "color" and "tokenId"`
      });
    }
  }

  // --- paint stacks ------------------------------------------------------
  for (const stack of COLOR_STACKS) {
    const value = el[stack];
    if (!Array.isArray(value)) continue;
    let changed = false;
    const next: unknown[] = [];
    value.forEach((entry, index) => {
      const rewritten = applyToPaint(entry, mode, `${path}/${stack}/${index}`, repairs);
      if (rewritten === undefined) {
        changed = true;
        return;
      }
      if (rewritten !== entry) changed = true;
      next.push(rewritten);
    });
    if (changed) edit()[stack] = next;
  }

  // --- number slots ------------------------------------------------------
  for (const [canonical, own] of byCanon) {
    const binding = NUMBER_SLOTS[canonical];
    const refused = REFUSED_NUMBER_SLOTS[canonical];
    const resolved = resolveSlotRef(el[own], mode.table, mode.vars);
    if (!resolved || (binding === undefined && refused === undefined)) continue;

    if (refused !== undefined) {
      repairs.push({
        kind: "token",
        path: `${path}/${own}`,
        message: `${resolved.label} in "${own}" is not supported: ${refused}`
      });
      delete edit()[own];
      continue;
    }
    if (TYPE_SLOTS.has(binding) && typeof el.type === "string" && el.type.toLowerCase() !== "text") {
      repairs.push({
        kind: "token",
        path: `${path}/${own}`,
        message: `"${own}" is read on a text layer only; the token was not bound`
      });
      delete edit()[own];
      continue;
    }

    const applied = finishNumberSlot(resolved, mode, `${path}/${own}`, repairs);
    if (!applied) {
      delete edit()[own];
      continue;
    }

    // `writeNumberValue` moves the VALUE; `bindNumberToken` also records the
    // binding and clears the spelling it supersedes. Both come from the DSL so
    // an author's `$radius-card` lands on the same shape the inspector writes.
    let next = bindNumberToken(out, binding, applied.token.id, applied.value);
    // A stroke weight with no stroke row yet: `bindNumberToken` moves the rows it
    // finds and writes nothing when there are none, so the scalar the stroke
    // reader falls back to is written here.
    if (binding === "strokeWidth" && !Array.isArray(el.strokes)) {
      next = { ...next, strokeWidth: applied.value };
    }
    out = next;
    if (own !== binding) delete (out as Record<string, unknown>)[own];
  }

  // --- padding per-side object / array / multi-value shorthand ----------
  if (isPlainObject(out.padding)) {
    const rawPad = out.padding as Record<string, unknown>;
    const nextPad: Record<string, unknown> = { ...rawPad };
    let padChanged = false;
    const addedBindings: Record<string, string> = {};
    for (const [sideKey, sideVal] of Object.entries(rawPad)) {
      const sideProp = PADDING_SIDE_PROPS[sideKey];
      if (!sideProp) continue;
      const resolved = resolveSlotRef(sideVal, mode.table, mode.vars);
      if (!resolved) continue;
      padChanged = true;
      const applied = finishNumberSlot(resolved, mode, `${path}/padding/${sideKey}`, repairs);
      if (!applied) {
        delete nextPad[sideKey];
      } else {
        nextPad[sideKey] = applied.value;
        addedBindings[sideProp] = applied.token.id;
      }
    }
    if (padChanged) {
      const draft = edit();
      if (Object.keys(rawPad).length > 0 && Object.keys(nextPad).length === 0) {
        delete draft.padding;
      } else {
        draft.padding = nextPad;
      }
      if (Object.keys(addedBindings).length > 0) {
        const cleared = withoutNumberBinding(draft.tokenBindings as Record<string, string> | undefined, "padding") ?? {};
        draft.tokenBindings = { ...cleared, ...addedBindings };
      }
    }
  } else if (Array.isArray(out.padding) || typeof out.padding === "string") {
    const rawItems = Array.isArray(out.padding)
      ? out.padding
      : splitSpacingTokens(out.padding.trim());
    const multi = Array.isArray(out.padding) ? rawItems.length >= 1 && rawItems.length <= 4 : rawItems.length >= 2 && rawItems.length <= 4;
    if (multi && rawItems.some((item) => resolveSlotRef(item, mode.table, mode.vars) !== null)) {
      const draft = edit();
      if (rawItems.length === 1) {
        const resolved = resolveSlotRef(rawItems[0], mode.table, mode.vars)!;
        const applied = finishNumberSlot(resolved, mode, `${path}/padding`, repairs);
        if (!applied) {
          delete draft.padding;
        } else {
          out = bindNumberToken(out, "padding", applied.token.id, applied.value);
          edit().padding = [applied.value, applied.value, applied.value, applied.value];
        }
      } else {
        const sides = expandFourSides(rawItems);
        const nextSides: unknown[] = [...sides];
        const sideBindings: Record<string, string> = {};
        let failed = false;
        for (let i = 0; i < 4; i++) {
          const resolved = resolveSlotRef(sides[i], mode.table, mode.vars);
          if (!resolved) continue;
          const applied = finishNumberSlot(resolved, mode, `${path}/padding`, repairs);
          if (!applied) {
            failed = true;
            break;
          }
          nextSides[i] = applied.value;
          sideBindings[PADDING_TUPLE_BINDINGS[i]] = applied.token.id;
        }
        if (failed) {
          delete draft.padding;
        } else {
          draft.padding = nextSides;
          const cleared = withoutNumberBinding(draft.tokenBindings as Record<string, string> | undefined, "padding") ?? {};
          draft.tokenBindings = { ...cleared, ...sideBindings };
        }
      }
    }
  }

  // --- rich text spans[].style -------------------------------------------
  if (Array.isArray(out.spans)) {
    const nextSpans = applyToSpans(out.spans, mode, path, repairs);
    if (nextSpans !== out.spans) edit().spans = nextSpans;
  }

  // --- existing references, by name --------------------------------------
  // The documented spelling is `tokenId: "<id>"`, and an id is minted. Accepting
  // the NAME there too costs one lookup and makes the published dialect usable
  // by the author who cannot read an id out of the file.
  //
  // Read from `out`, not from `el`: the number-slot pass above may have just
  // bound a NEW token to one of these props, and replaying the input's binding
  // would write the old id — and the old value — straight back over it.
  const bindings = out.tokenBindings;
  if (isPlainObject(bindings)) {
    for (const [prop, bound] of Object.entries(bindings)) {
      const token = lookupToken(bound, mode.table);
      if (!token) continue;
      const value = numberOf(token, mode);
      if (value === undefined) {
        reportSlotError("type", String(bound), `${path}/tokenBindings/${prop}`, "number", repairs);
        continue;
      }
      // The recorded binding is a POINTER: rewriting it here is what makes a
      // document that named its tokens by hand keep pointing at the same entry
      // after the id is resolved.
      const draft = edit();
      draft.tokenBindings = { ...(draft.tokenBindings as Record<string, string>), [prop]: token.id };
      if (CORNER_SLOTS[prop] !== undefined && draft.borderRadius === undefined) {
        const radiusRaw = cornerRadiusInput(draft);
        const radius =
          typeof radiusRaw === "string"
            ? parseRadiusString(
                radiusRaw,
                typeof el.width === "number" && typeof el.height === "number"
                  ? { width: el.width, height: el.height }
                  : undefined
              )
            : Array.isArray(radiusRaw) || typeof radiusRaw === "number"
              ? radiusRaw
              : undefined;
        if (radius !== undefined) draft.borderRadius = radius;
      }
      const deferPaddingShape =
        PADDING_SLOTS[prop] !== undefined &&
        isPlainObject(out.padding) &&
        Object.values(out.padding).some((v) => typeof v !== "number");
      if (!deferPaddingShape) {
        out = writeNumberValue(out, prop, value);
      }
      if (prop === "strokeWidth" && !Array.isArray(out.strokes)) {
        out = { ...out, strokeWidth: value };
      }
      for (const own of Object.keys(out)) {
        const target = NUMBER_SLOTS[canonicalKey(own)];
        if (!target || own === target) continue;
        if (target === prop || (CORNER_SLOTS[prop] !== undefined && target === "borderRadius")) {
          delete (out as Record<string, unknown>)[own];
        }
      }
    }
  }

  // --- children ----------------------------------------------------------
  if (Array.isArray(el.children)) {
    let changed = false;
    const children = el.children.map((child, index) => {
      if (!isPlainObject(child)) return child;
      const next = applyToElement(child, mode, `${path}/children/${index}`, repairs);
      if (next !== child) changed = true;
      return next;
    });
    if (changed) edit().children = children;
  }

  return out;
}

/** Resolves `$token` / `var(--name)` inside `spans[].style` against active element modes (spans hold no persistent `tokenId`). */
function applyToSpans(
  spans: unknown[],
  mode: TokenSlotContext,
  path: string,
  repairs: NormalizationRepair[]
): unknown[] {
  let changed = false;
  const nextSpans = spans.map((span, index) => {
    if (!isPlainObject(span) || !isPlainObject(span.style)) return span;
    const rawStyle = span.style as Record<string, unknown>;
    let nextStyle: Record<string, unknown> | null = null;
    const editStyle = () => (nextStyle ??= { ...rawStyle });

    for (const [styleKey, styleVal] of Object.entries(rawStyle)) {
      const canon = canonicalKey(styleKey);
      const isColor = canon === "color" || canon === "fill";
      const isNum = canon === "font-size" || canon === "size" || canon === "letter-spacing";
      if (!isColor && !isNum) continue;
      const resolved = resolveSlotRef(styleVal, mode.table, mode.vars);
      if (!resolved) continue;
      const itemPath = `${path}/spans/${index}/style/${styleKey}`;
      if (isColor) {
        const applied = finishColorSlot(resolved, mode, itemPath, repairs);
        if (!applied) delete editStyle()[styleKey];
        else editStyle()[styleKey] = applied.color;
      } else {
        const applied = finishNumberSlot(resolved, mode, itemPath, repairs);
        if (!applied) delete editStyle()[styleKey];
        else editStyle()[styleKey] = applied.value;
      }
    }

    if (!nextStyle) return span;
    changed = true;
    if (Object.keys(nextStyle).length === 0) {
      const { style: _empty, ...rest } = span;
      return rest;
    }
    return { ...span, style: nextStyle };
  });
  return changed ? nextSpans : spans;
}

/** Resolves paint stacks and typography bindings inside a `doc.styles[]` entry. */
function applyToStyleEntry(
  entry: Record<string, unknown>,
  base: TokenSlotContext,
  path: string,
  repairs: NormalizationRepair[]
): Record<string, unknown> {
  let out = entry;
  const edit = () => (out === entry ? (out = { ...entry }) : out);

  for (const stack of ["paints", "fills", "strokes", "effects"] as const) {
    const arr = entry[stack];
    if (!Array.isArray(arr)) continue;
    let stackChanged = false;
    const next: unknown[] = [];
    arr.forEach((item, index) => {
      const rewritten = applyToPaint(item, base, `${path}/${stack}/${index}`, repairs);
      if (rewritten === undefined) {
        stackChanged = true;
        return;
      }
      if (rewritten !== item) stackChanged = true;
      next.push(rewritten);
    });
    if (stackChanged) edit()[stack] = next;
  }

  const styleType = entry.styleType ?? entry.type;
  if (styleType === "text" && isPlainObject(entry.style)) {
    const rawStyle = entry.style as Record<string, unknown>;
    let nextStyle: Record<string, unknown> | null = null;
    const editStyle = () => (nextStyle ??= { ...rawStyle });
    for (const [key, val] of Object.entries(rawStyle)) {
      const canon = canonicalKey(key);
      const target = canon === "font-size" || canon === "size"
        ? "fontSize"
        : canon === "line-height"
          ? "lineHeight"
          : canon === "letter-spacing"
            ? "letterSpacing"
            : undefined;
      if (!target) continue;
      const resolved = resolveSlotRef(val, base.table, base.vars);
      if (!resolved) continue;
      const applied = finishNumberSlot(resolved, base, `${path}/style/${key}`, repairs);
      if (!applied) {
        delete editStyle()[key];
        continue;
      }
      const draftStyle = editStyle();
      if (key !== target) delete draftStyle[key];
      draftStyle[target] = numberTokenPropValue(target, applied.value);
      const prevBindings = isPlainObject(draftStyle.tokenBindings)
        ? (draftStyle.tokenBindings as Record<string, string>)
        : {};
      draftStyle.tokenBindings = { ...prevBindings, [target]: applied.token.id };
    }
    if (nextStyle) edit().style = nextStyle;
  }

  return out;
}

/**
 * One element, rewritten. The `op: patch` / `replace` / `insert` verbs use this
 * directly: they hand over the props they were given, not a whole document, and
 * a patch that names a token has to land the same shape a full load would.
 */
export function applyTokenShorthandsToElement(
  el: Record<string, unknown>,
  tokens: unknown,
  modes: ShorthandModes,
  path: string,
  repairs: NormalizationRepair[],
  vars?: Variables
): Record<string, unknown> {
  const table = buildTokenRefTable(tokens);
  if (table.empty) return el;
  const docTheme = themeOf(modes);
  const docNumberMode = numberModeOf(modes);
  return applyToElement(el, { table, theme: docTheme, numberMode: docNumberMode, vars }, path, repairs);
}

function applyToCanvas(
  rawCanvas: unknown,
  ctx: TokenSlotContext,
  path: string,
  repairs: NormalizationRepair[]
): unknown {
  if (!isPlainObject(rawCanvas)) return rawCanvas;
  let out: Record<string, unknown> | null = null;
  const edit = () => (out ??= { ...rawCanvas });
  for (const key of ["background", "backgroundColor"] as const) {
    if (rawCanvas[key] === undefined) continue;
    const next = applyToPaint(rawCanvas[key], ctx, `${path}/${key}`, repairs);
    if (next !== rawCanvas[key]) {
      edit()[key] = next;
    }
  }
  return out ?? rawCanvas;
}

/**
 * Rewrite every `$token` and `var(--name)` token reference in a raw document.
 *
 * Returns the document it was given when `doc.tokens` is empty, so a
 * document that does not use the feature pays one array scan per token table and
 * nothing else — no copies, no repairs, byte-identical output.
 */
export function applyTokenShorthandsToDocument(
  source: Record<string, unknown>,
  repairs: NormalizationRepair[],
  vars?: Variables
): Record<string, unknown> {
  const table = buildTokenRefTable(source.tokens);
  if (table.empty) return source;

  const docTheme = themeOf({ activeTheme: source.activeTheme, modes: source.modes });
  const docNumberMode = numberModeOf({
    activeNumberMode: source.activeNumberMode,
    numberModes: source.numberModes
  });
  const base: TokenSlotContext = { table, theme: docTheme, numberMode: docNumberMode, vars };

  let out = source;
  const edit = () => (out === source ? (out = { ...source }) : out);

  if (isPlainObject(source.canvas)) {
    const nextCanvas = applyToCanvas(source.canvas, base, "/canvas", repairs);
    if (nextCanvas !== source.canvas) edit().canvas = nextCanvas;
  }

  if (Array.isArray(source.styles)) {
    let changed = false;
    const styles = source.styles.map((style, index) => {
      if (!isPlainObject(style)) return style;
      const next = applyToStyleEntry(style, base, `/styles/${index}`, repairs);
      if (next !== style) changed = true;
      return next;
    });
    if (changed) edit().styles = styles;
  }

  if (Array.isArray(source.elements)) {
    let changed = false;
    const elements = source.elements.map((el, index) => {
      if (!isPlainObject(el)) return el;
      const next = applyToElement(el, base, `/elements/${index}`, repairs);
      if (next !== el) changed = true;
      return next;
    });
    if (changed) edit().elements = elements;
  }

  if (Array.isArray(source.pages)) {
    let changed = false;
    const pages = source.pages.map((page, pIndex) => {
      if (!isPlainObject(page)) return page;
      let pageChanged = false;
      let nextCanvas = page.canvas;
      if (isPlainObject(page.canvas)) {
        nextCanvas = applyToCanvas(page.canvas, base, `/pages/${pIndex}/canvas`, repairs);
        if (nextCanvas !== page.canvas) pageChanged = true;
      }
      let nextChildren = page.children;
      if (Array.isArray(page.children)) {
        let childrenChanged = false;
        const mapped = page.children.map((el, index) => {
          if (!isPlainObject(el)) return el;
          const next = applyToElement(el, base, `/pages/${pIndex}/children/${index}`, repairs);
          if (next !== el) childrenChanged = true;
          return next;
        });
        if (childrenChanged) {
          nextChildren = mapped;
          pageChanged = true;
        }
      }
      if (!pageChanged) return page;
      changed = true;
      return { ...page, ...(nextCanvas !== page.canvas ? { canvas: nextCanvas } : {}), children: nextChildren };
    });
    if (changed) edit().pages = pages;
  }

  return out;
}

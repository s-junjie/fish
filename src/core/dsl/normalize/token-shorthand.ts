/**
 * `$token` shorthands: an author (or an agent) writes the token's name where a
 * value belongs, and normalize turns it into the stored pair the renderer reads
 * — the reference AND the value, exactly as the inspector's bind command writes
 * them.
 *
 * Why this pass exists at all: an id is minted (`createId("tok")` → `tok_<rep>_…
 * _1`), so a hand-written document cannot name a token by id, and an imported
 * one names it `color/surface` — a spelling no `tokenId` field accepts. The two
 * tables a document already publishes (`tokenId`, `tokenBindings`) are therefore
 * unusable by the one author who cannot click: an agent. `$color-surface` is the
 * shortest thing that can only mean one thing.
 *
 * Why it runs HERE (over the raw document, before any element is normalized)
 * rather than inside `normalizeElement`: only the document has `tokens`, and
 * without the table this pass cannot answer the three questions that make the
 * feature honest — which token did you mean, is it the right TYPE for this slot,
 * and what is it worth in the current mode. Element-level normalize has none of
 * them, and its only possible answer is a placeholder, which for a typo is an
 * invisible layer with no repair.
 *
 * One syntax, on purpose. `var(--x)` is already the document's own variables
 * (`resolve-values.ts` folds it before this runs, and `dsl.md` publishes it as
 * "authoring-time substitution only"), so borrowing it would give one spelling
 * two meanings decided by which table happens to hold the name.
 */

import type { ColorToken, DesignToken, NumberToken } from "../types";
import { normalizeTokens } from "./tokens";
import { tryColorTokenValue, numberModeOf, tryNumberTokenValue, themeOf } from "../token-value";
import { bindNumberToken, CORNER_SLOTS, writeNumberValue } from "../token-bindings";
import { cornerRadiusInput, parseBorderShorthand, parseRadiusString } from "./stroke";
import { parseBoxShadows } from "../../import/css-values";
import { canonicalKey, isPlainObject, type NormalizationRepair } from "./shared";

/** `$x` — one prefix, no function call. `/` stays legal so a real name works. */
const TOKEN_REF = /^\$([A-Za-z0-9._/-]+)$/;

export function parseTokenRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = TOKEN_REF.exec(value.trim());
  return match ? match[1] : null;
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

type Resolution =
  | { token: DesignToken }
  | { error: "unknown" | "ambiguous" | "dropped" | "type"; ref: string };

/**
 * Resolve a reference: id first (it is unique by construction), then the exact
 * name, then the slug. A tie is never resolved by guessing — two tokens that
 * slug to the same word are a fact about the document, and picking one would
 * bind a layer to a token the author cannot see it pointing at.
 */
export function resolveTokenRef(ref: string, table: TokenRefTable): Resolution {
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

/** Slots that exist in CSS and in this dialect, but not as a token binding. */
const REFUSED_NUMBER_SLOTS: Readonly<Record<string, string>> = {
  width: 'a size is the `sizing` axis; write the number or a size mode',
  height: 'a size is the `sizing` axis; write the number or a size mode',
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

interface Context {
  table: TokenRefTable;
  /** The effective mode at this node: its own override, else the inherited one. */
  theme: string;
  numberMode: string;
}

const colorOf = (token: DesignToken, ctx: Context): string | undefined =>
  token.type === "color" ? tryColorTokenValue(token as ColorToken, ctx.theme, ctx.table.byId) : undefined;

const numberOf = (token: DesignToken, ctx: Context): number | undefined =>
  token.type === "number" ? tryNumberTokenValue(token as NumberToken, ctx.numberMode, ctx.table.byId) : undefined;

function reportError(
  error: "unknown" | "ambiguous" | "dropped" | "type",
  ref: string,
  where: string,
  wants: "colour" | "number",
  repairs: NormalizationRepair[]
): void {
  const message =
    error === "unknown"
      ? `"$${ref}" names no token; the declaration was dropped`
      : error === "ambiguous"
        ? `"$${ref}" matches more than one token by name; nothing was bound`
        : error === "dropped"
          ? `"$${ref}" names a token whose value was dropped; nothing was bound`
          : `"$${ref}" is not a ${wants} token`;
  repairs.push({ kind: "token", path: `${where}`, message });
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

/** A paint, a stroke row or an effect: its own `color`, plus a gradient's stops. */
function applyToPaint(
  entry: unknown,
  ctx: Context,
  path: string,
  repairs: NormalizationRepair[]
): unknown {
  if (typeof entry === "string") {
    const ref = parseTokenRef(entry);
    if (!ref) return entry;
    const found = resolveTokenRef(ref, ctx.table);
    if ("error" in found) {
      reportError(found.error, ref, path, "colour", repairs);
      return undefined;
    }
    const color = colorOf(found.token, ctx);
    if (color === undefined) {
      reportError("type", ref, path, "colour", repairs);
      return undefined;
    }
    return { type: "solid", color, tokenId: found.token.id };
  }
  if (!isPlainObject(entry)) return entry;

  let out: Record<string, unknown> | null = null;
  const edit = () => (out ??= { ...entry });

  const colorRef = parseTokenRef(entry.color);
  if (colorRef) {
    const found = resolveTokenRef(colorRef, ctx.table);
    if ("error" in found) {
      reportError(found.error, colorRef, `${path}/color`, "colour", repairs);
      return undefined;
    }
    const color = colorOf(found.token, ctx);
    if (color === undefined) {
      reportError("type", colorRef, `${path}/color`, "colour", repairs);
      return undefined;
    }
    edit().color = color;
    edit().tokenId = found.token.id;
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

  const stops = entry.stops;
  if (Array.isArray(stops) && stops.some((stop) => isPlainObject(stop) && parseTokenRef(stop.color))) {
    edit().stops = stops.map((stop, index) => {
      if (!isPlainObject(stop)) return stop;
      const ref = parseTokenRef(stop.color);
      if (!ref) return stop;
      const found = resolveTokenRef(ref, ctx.table);
      if ("error" in found) {
        reportError(found.error, ref, `${path}/stops/${index}`, "colour", repairs);
        return stop;
      }
      const color = colorOf(found.token, ctx);
      if (color === undefined) {
        reportError("type", ref, `${path}/stops/${index}`, "colour", repairs);
        return stop;
      }
      return { ...stop, color, tokenId: found.token.id };
    });
  }

  return out ?? entry;
}

/** One element: colour slots, number slots, existing references, then children. */
function applyToElement(
  el: Record<string, unknown>,
  ctx: Context,
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
  const mode: Context =
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
    const ref = parseTokenRef(el[own]);
    if (!ref) continue;
    if (el.fills !== undefined) {
      repairs.push({
        kind: "token",
        path: `${path}/${own}`,
        message: `"${own}" ignored: fills is already set`
      });
      continue;
    }
    const found = resolveTokenRef(ref, mode.table);
    if ("error" in found) {
      reportError(found.error, ref, `${path}/${own}`, "colour", repairs);
      delete edit()[own];
      continue;
    }
    const color = colorOf(found.token, mode);
    if (color === undefined) {
      reportError("type", ref, `${path}/${own}`, "colour", repairs);
      delete edit()[own];
      continue;
    }
    const draft = edit();
    delete draft[own];
    (draft as Record<string, unknown>)[target] = [{ type: "solid", color, tokenId: found.token.id }];
    break;
  }

  // --- border colour -----------------------------------------------------
  // `border` is the structured slot (`normalizeStroke` reads `border.tokenId`).
  // A string `border` is the CSS shorthand, which this pass does not rewrite:
  // merging a colour into it would silently drop the width and style it carries.
  const borderColorKey = byCanon.get("border-color");
  const borderColorRef = borderColorKey ? parseTokenRef(el[borderColorKey]) : null;
  if (borderColorKey && borderColorRef) {
    const found = resolveTokenRef(borderColorRef, mode.table);
    const color = "token" in found ? colorOf(found.token, mode) : undefined;
    if (el.border !== undefined) {
      repairs.push({
        kind: "token",
        path: `${path}/${borderColorKey}`,
        message: `"${borderColorKey}" ignored: border is already set (write the token there)`
      });
    } else if (!("token" in found)) {
      reportError(found.error, borderColorRef, `${path}/${borderColorKey}`, "colour", repairs);
      delete edit()[borderColorKey];
    } else if (color === undefined) {
      reportError("type", borderColorRef, `${path}/${borderColorKey}`, "colour", repairs);
      delete edit()[borderColorKey];
    } else {
      const draft = edit();
      delete draft[borderColorKey];
      draft.border = { color, tokenId: found.token.id };
    }
  }

  // --- `border` shorthand: the colour lives inside a string ---------------
  // Split by the parser that already knows `<width> || <style> || <color>`, then
  // lowered onto the structured object `normalizeStroke` reads — so the width and
  // style the author wrote survive, which is the whole reason not to rewrite the
  // string in place.
  if (typeof el.border === "string") {
    const parsed = parseBorderShorthand(el.border);
    const ref = parsed?.color ? parseTokenRef(parsed.color) : null;
    if (ref) {
      const found = resolveTokenRef(ref, mode.table);
      const color = "token" in found ? colorOf(found.token, mode) : undefined;
      if (!("token" in found)) {
        reportError(found.error, ref, `${path}/border`, "colour", repairs);
        delete edit().border;
      } else if (color === undefined) {
        reportError("type", ref, `${path}/border`, "colour", repairs);
        delete edit().border;
      } else {
        edit().border = {
          ...(parsed!.width !== undefined ? { width: parsed!.width } : {}),
          ...(parsed!.style ? { style: parsed!.style } : {}),
          color,
          tokenId: found.token.id
        };
      }
    }
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
    const ref = parseTokenRef(el[own]);
    if (!ref || (binding === undefined && refused === undefined)) continue;

    if (refused !== undefined) {
      repairs.push({
        kind: "token",
        path: `${path}/${own}`,
        message: `"$${ref}" in "${own}" is not supported: ${refused}`
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

    const found = resolveTokenRef(ref, mode.table);
    if (!("token" in found)) {
      reportError(found.error, ref, `${path}/${own}`, "number", repairs);
      delete edit()[own];
      continue;
    }
    const value = numberOf(found.token, mode);
    if (value === undefined) {
      reportError("type", ref, `${path}/${own}`, "number", repairs);
      delete edit()[own];
      continue;
    }

    // `writeNumberValue` moves the VALUE; `bindNumberToken` also records the
    // binding and clears the spelling it supersedes. Both come from the DSL so
    // an author's `$radius-card` lands on the same shape the inspector writes.
    let next = bindNumberToken(out, binding, found.token.id, value);
    // A stroke weight with no stroke row yet: `bindNumberToken` moves the rows it
    // finds and writes nothing when there are none, so the scalar the stroke
    // reader falls back to is written here.
    if (binding === "strokeWidth" && !Array.isArray(el.strokes)) {
      next = { ...next, strokeWidth: value };
    }
    out = next;
    if (own !== binding) delete (out as Record<string, unknown>)[own];
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
        reportError("type", String(bound), `${path}/tokenBindings/${prop}`, "number", repairs);
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
      out = writeNumberValue(out, prop, value);
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

/** The parts of a document a rewrite needs: the table and the modes in scope. */
export interface ShorthandModes {
  activeTheme?: unknown;
  activeNumberMode?: unknown;
  modes?: unknown;
  numberModes?: unknown;
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
  repairs: NormalizationRepair[]
): Record<string, unknown> {
  const table = buildTokenRefTable(tokens);
  if (table.empty) return el;
  const docTheme = themeOf(modes);
  const docNumberMode = numberModeOf(modes);
  return applyToElement(el, { table, theme: docTheme, numberMode: docNumberMode }, path, repairs);
}

/**
 * Rewrite every `$token` reference in a raw document.
 *
 * Returns the document it was given when nothing referred to a token, so a
 * document that does not use the feature pays one array scan per token table and
 * nothing else — no copies, no repairs, byte-identical output.
 */
export function applyTokenShorthandsToDocument(
  source: Record<string, unknown>,
  repairs: NormalizationRepair[]
): Record<string, unknown> {
  const table = buildTokenRefTable(source.tokens);
  if (table.empty) return source;

  const docTheme = themeOf({ activeTheme: source.activeTheme, modes: source.modes });
  const docNumberMode = numberModeOf({
    activeNumberMode: source.activeNumberMode,
    numberModes: source.numberModes
  });
  const base: Context = { table, theme: docTheme, numberMode: docNumberMode };

  let out = source;
  const edit = () => (out === source ? (out = { ...source }) : out);

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
      if (!isPlainObject(page) || !Array.isArray(page.children)) return page;
      let pageChanged = false;
      const children = page.children.map((el, index) => {
        if (!isPlainObject(el)) return el;
        const next = applyToElement(el, base, `/pages/${pIndex}/children/${index}`, repairs);
        if (next !== el) pageChanged = true;
        return next;
      });
      if (!pageChanged) return page;
      changed = true;
      return { ...page, children };
    });
    if (changed) edit().pages = pages;
  }

  return out;
}

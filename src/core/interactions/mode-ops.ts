import {
  ColorToken,
  DesignDocument,
  DesignElement,
  DesignToken,
  DocumentMode,
  InstanceElement,
  NumberToken
} from "../dsl/types";
import { getActivePage } from "../dsl/types";
import { composeColorAlpha, parseColorAlpha } from "../geometry/color-utils";
import { isContainer } from "../geometry/tree-ops";
import { relayoutDocumentTree } from "../layout/auto-layout";
import { findMasterComponent } from "./component-inventory";
import {
  cascadeTokensIntoStyles,
  resolveColorTokenHex,
  resolveNumberTokenVal,
  syncDualStorage
} from "./style-sync";
import { styleTables, StyleTables } from "./style-tables";

/** The default theme if none is specified on the document. */
export const DEFAULT_THEME = "default";

/** The default modes built into every new document. Starts with a single primary mode named "Default". */
export const DEFAULT_MODES: DocumentMode[] = [
  { id: "default", name: "Default" }
];

/**
 * The number axis' default list — the same single primary mode the colour axis
 * starts with. Being a separate array and not `DEFAULT_MODES` keeps the two axes
 * from ever sharing an entry object, which is what a later in-place rename would
 * need to stay out of.
 */
export const DEFAULT_NUMBER_MODES: DocumentMode[] = [
  { id: "default", name: "Default" }
];

/**
 * The two orthogonal axes a token table can be filed under.
 *
 * A colour answers to brightness and brand, a number to density and breakpoint;
 * each axis owns its mode list, its active selection, and the element field that
 * overrides both for a subtree. Everything below is written once and dispatched
 * on this tag, so the pair cannot drift the way two hand-copied implementations
 * would.
 */
type ModeAxis = "color" | "number";

const AXES: Record<
  ModeAxis,
  { list: "modes" | "numberModes"; active: "activeTheme" | "activeNumberMode"; defaults: DocumentMode[]; field: "themeMode" | "numberMode" }
> = {
  color: { list: "modes", active: "activeTheme", defaults: DEFAULT_MODES, field: "themeMode" },
  number: { list: "numberModes", active: "activeNumberMode", defaults: DEFAULT_NUMBER_MODES, field: "numberMode" }
};

function axisModes(doc: DesignDocument, axis: ModeAxis): DocumentMode[] {
  const declared = doc[AXES[axis].list];
  return declared && declared.length > 0 ? declared : AXES[axis].defaults;
}

/** Returns the active theme identifier of the document. */
export function getActiveTheme(doc: DesignDocument): string {
  return doc.activeTheme || getDocumentModes(doc)[0]?.id || DEFAULT_THEME;
}

/**
 * Returns the active number mode of the document.
 *
 * Never the colour mode: brightness and density are independent, and a colour
 * switch that moved every radius is the defect the split exists to remove. A
 * document written before the split is migrated by `normalize` — the number
 * axis adopts the colour mode ids its tokens actually filed values under — so
 * an old file keeps its per-mode numbers without this reader guessing.
 */
export function getActiveNumberMode(doc: DesignDocument): string {
  return doc.activeNumberMode || getDocumentNumberModes(doc)[0]?.id || DEFAULT_THEME;
}

/** Returns the available theme modes for the document, falling back to default. */
export function getDocumentModes(doc: DesignDocument): DocumentMode[] {
  return axisModes(doc, "color");
}

/** Returns the available number modes for the document, falling back to default. */
export function getDocumentNumberModes(doc: DesignDocument): DocumentMode[] {
  return axisModes(doc, "number");
}

/**
 * A readable id for a new mode when the name affords one, so `Compact` lands as
 * `compact` — the id is what a CSS export writes into `[data-…="compact"]`, and
 * a random suffix there is a value nobody can author against. A name that is not
 * ascii-safe, or already taken, gets a unique generated id instead.
 */
function modeIdFor(name: string, taken: readonly DocumentMode[]): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug && /^[a-z]/.test(slug) && !taken.some((m) => m.id === slug)) return slug;
  return `mode_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function addAxisMode(
  doc: DesignDocument,
  axis: ModeAxis,
  name: string
): { doc: DesignDocument; mode: DocumentMode } {
  const currentModes = axisModes(doc, axis);
  const cleanName = name.trim() || `Mode ${currentModes.length + 1}`;
  const newMode: DocumentMode = { id: modeIdFor(cleanName, currentModes), name: cleanName };
  const nextModes = [...currentModes, newMode];
  return {
    doc: axis === "color" ? { ...doc, modes: nextModes } : { ...doc, numberModes: nextModes },
    mode: newMode
  };
}

function renameAxisMode(
  doc: DesignDocument,
  axis: ModeAxis,
  modeId: string,
  name: string
): DesignDocument {
  const cleanName = name.trim();
  if (!cleanName) return doc;
  const nextModes = axisModes(doc, axis).map((m) => (m.id === modeId ? { ...m, name: cleanName } : m));
  return axis === "color" ? { ...doc, modes: nextModes } : { ...doc, numberModes: nextModes };
}

/** Adds a new mode to the document's COLOUR axis. */
export function addDocumentMode(
  doc: DesignDocument,
  name: string
): { doc: DesignDocument; mode: DocumentMode } {
  return addAxisMode(doc, "color", name);
}

/** Adds a new mode to the document's NUMBER axis. */
export function addDocumentNumberMode(
  doc: DesignDocument,
  name: string
): { doc: DesignDocument; mode: DocumentMode } {
  return addAxisMode(doc, "number", name);
}

/** Renames an existing mode on the COLOUR axis. */
export function renameDocumentMode(
  doc: DesignDocument,
  modeId: string,
  name: string
): DesignDocument {
  return renameAxisMode(doc, "color", modeId, name);
}

/** Renames an existing mode on the NUMBER axis. */
export function renameDocumentNumberMode(
  doc: DesignDocument,
  modeId: string,
  name: string
): DesignDocument {
  return renameAxisMode(doc, "number", modeId, name);
}

/**
 * Deletes a mode from one axis of the document.
 *
 * Requires at least one mode to remain on that axis. If the base mode (first
 * mode) is deleted, the next mode becomes the new base mode, and its overrides
 * promote to the token's base value. If the deleted mode was active, the axis'
 * active id reverts to the new base mode.
 */
function deleteAxisMode(doc: DesignDocument, axis: ModeAxis, modeId: string): DesignDocument {
  const currentModes = axisModes(doc, axis);
  if (currentModes.length <= 1) return doc;
  const nextModes = currentModes.filter((m) => m.id !== modeId);
  const newBaseMode = nextModes[0];
  const isDeletingBase = currentModes[0]?.id === modeId;

  let nextDoc = doc;
  if (activeOf(doc, axis) === modeId) {
    nextDoc = switchAxisMode(doc, axis, newBaseMode.id);
  }

  // Only TOKENS carry per-mode values; a style's modes come from the tokens it
  // references, so there is nothing to clean up on `doc.styles` here. And only
  // the tokens of THIS axis are keyed by this axis' ids — a colour token's
  // `modes` map names colour modes, a number token's names number modes.
  //
  // The BASE mode's value lives in `token.value`, never in `token.modes`, so
  // deleting it is not "remove a key" — the next mode's override has to be
  // PROMOTED into `value` first. Guarding on `modeId in token.modes` alone made
  // that a no-op for exactly the mode it mattered for, leaving the surviving
  // mode's value stranded in `modes` and the document showing the old base.
  const ownsToken = (token: DesignToken): boolean =>
    axis === "color" ? token.type === "color" : token.type === "number";

  const cleanedTokens = (nextDoc.tokens || []).map((token): DesignToken => {
    if (!ownsToken(token)) return token;
    const promoted = isDeletingBase && token.modes?.[newBaseMode.id] !== undefined;
    if (!promoted && (!token.modes || !(modeId in token.modes))) return token;
    const nextModesMap = { ...(token.modes ?? {}) };
    const nextValue = promoted ? (nextModesMap[newBaseMode.id] as never) : token.value;
    delete nextModesMap[modeId];
    delete nextModesMap[newBaseMode.id];
    const modes = Object.keys(nextModesMap).length > 0 ? nextModesMap : undefined;
    return { ...token, value: nextValue, modes } as DesignToken;
  });

  const withList: DesignDocument =
    axis === "color" ? { ...nextDoc, modes: nextModes } : { ...nextDoc, numberModes: nextModes };

  // The promoted value is a token edit like any other: styles that follow the
  // token, and the layers that follow those styles, must move in the same commit.
  return cascadeDocumentForMode({ ...withList, tokens: cleanedTokens });
}

/** Deletes a mode from the COLOUR axis. */
export function deleteDocumentMode(doc: DesignDocument, modeId: string): DesignDocument {
  return deleteAxisMode(doc, "color", modeId);
}

/** Deletes a mode from the NUMBER axis. */
export function deleteDocumentNumberMode(doc: DesignDocument, modeId: string): DesignDocument {
  return deleteAxisMode(doc, "number", modeId);
}

/** The active id of an axis, without the legacy fallback `getActiveNumberMode` carries. */
function activeOf(doc: DesignDocument, axis: ModeAxis): string {
  const declared = doc[AXES[axis].list];
  if (!declared || declared.length === 0) return AXES[axis].defaults[0].id;
  const active = doc[AXES[axis].active];
  return active || declared[0].id;
}

/**
 * Re-materialize the whole document after a token's values changed underneath it.
 *
 * Seedless: every token is cascaded, because two modes being removed can change
 * a token even when no single id was edited (`deleteDocumentMode`).
 */
function cascadeDocumentForMode(doc: DesignDocument): DesignDocument {
  const activeTheme = getActiveTheme(doc);
  const activeNumberMode = getActiveNumberMode(doc);
  const tokens = doc.tokens ?? [];
  const styles = cascadeTokensIntoStyles(doc.styles || [], tokens, activeTheme, undefined, activeNumberMode);
  const tables = styleTables({ tokens, styles });
  const syncTree = (children: DesignElement[]) =>
    children.map((el) => syncDualStorage(el, tables, activeTheme, activeNumberMode));

  return {
    ...doc,
    styles,
    pages: (doc.pages || []).map((page) => ({ ...page, children: relayoutDocumentTree(syncTree(page.children || [])) }))
  };
}

/** Extracts the solid color of a Color Token in the given theme, falling back to base/default. */
export function getColorTokenModeColor(token: ColorToken, theme?: string): string {
  return resolveColorTokenHex(token, theme);
}

/** Extracts the numerical value of a Number Token in the given mode, falling back to base/default. */
export function getNumberTokenModeValue(token: NumberToken, mode?: string): number {
  return resolveNumberTokenVal(token, mode);
}

export interface ColorModePatch {
  color: string;
  opacity?: number;
}

/**
 * Updates a Color Token's values for base or any theme modes.
 * `modesOrOverrides` can be a string (dark hex) or a dictionary of mode overrides.
 *
 * Alpha is not a field: it is folded into the stored hex (`#RRGGBBAA`), which is
 * the one encoding a colour token has now that there is no paint object to hang
 * an `opacity` on.
 */
export function updateColorTokenWithModes(
  token: ColorToken,
  name: string,
  baseColor: string,
  modesOrOverrides?: string | Record<string, string | ColorModePatch | undefined>,
  description?: string,
  baseOpacity?: number,
  baseModeId?: string
): ColorToken {
  /* A number for `opacity` is a REQUEST about the alpha, not a hint: 1 means
     "opaque", so an 8-digit colour has to lose its trailing byte. Returning the
     colour unchanged left a reset to 100% looking like nothing happened. */
  const encode = (color: string, opacity?: number): string => {
    const parsed = parseColorAlpha(color);
    if (typeof opacity !== "number") return color;
    return opacity < 1
      ? composeColorAlpha(parsed.hex6, Math.round(opacity * 100))
      : parsed.hex6;
  };

  let nextModes: Record<string, string> | undefined = token.modes ? { ...token.modes } : undefined;
  const patches = typeof modesOrOverrides === "string" ? { dark: modesOrOverrides } : modesOrOverrides;

  if (patches && typeof patches === "object") {
    nextModes = nextModes ? { ...nextModes } : {};
    for (const [modeId, value] of Object.entries(patches)) {
      if (baseModeId ? modeId === baseModeId : (modeId === DEFAULT_THEME || modeId === "light")) {
        delete nextModes[modeId];
        continue;
      }
      if (value === undefined || value === null) {
        delete nextModes[modeId];
      } else if (typeof value === "string") {
        // A string carries its own alpha: `baseOpacity` describes the BASE mode,
        // and folding it in here painted one mode with the other mode's alpha.
        if (value.trim()) nextModes[modeId] = value.trim();
        else delete nextModes[modeId];
      } else if (typeof value === "object" && value.color && value.color.trim()) {
        nextModes[modeId] = encode(value.color.trim(), value.opacity);
      }
    }
    if (baseModeId && baseModeId in nextModes) delete nextModes[baseModeId];
    if (Object.keys(nextModes).length === 0) nextModes = undefined;
  }

  return {
    ...token,
    name: name.trim() || token.name,
    description: description !== undefined ? description.trim() : token.description,
    value: encode(baseColor, baseOpacity),
    ...(nextModes ? { modes: nextModes } : { modes: undefined })
  };
}

/**
 * Updates a Number Token's values for the base mode or any other number mode.
 * `modesOrBase` can be a number or a dictionary of mode overrides `{ [modeId]: value }`.
 */
export function updateNumberTokenWithModes(
  token: NumberToken,
  name: string,
  category: NumberToken["category"],
  baseValue: number,
  modesOrBase?: number | Record<string, number | undefined>,
  description?: string,
  baseModeId?: string
): NumberToken {
  let nextModes: Record<string, number> | undefined = token.modes ? { ...token.modes } : undefined;
  const patches = typeof modesOrBase === "number" ? { dark: modesOrBase } : modesOrBase;

  if (patches && typeof patches === "object") {
    nextModes = nextModes ? { ...nextModes } : {};
    for (const [modeId, numVal] of Object.entries(patches)) {
      if (baseModeId ? modeId === baseModeId : (modeId === DEFAULT_THEME || modeId === "light")) {
        delete nextModes[modeId];
        continue;
      }
      if (numVal !== undefined && !Number.isNaN(numVal)) {
        nextModes[modeId] = numVal;
      } else if (modeId in nextModes) {
        delete nextModes[modeId];
      }
    }
    if (baseModeId && baseModeId in nextModes) delete nextModes[baseModeId];
    if (Object.keys(nextModes).length === 0) nextModes = undefined;
  }

  return {
    ...token,
    name: name.trim() || token.name,
    category,
    value: baseValue,
    description: description !== undefined ? description.trim() : token.description,
    ...(nextModes ? { modes: nextModes } : { modes: undefined })
  };
}

/**
 * Switches the active id of one axis and rematerializes every token-bound and
 * style-bound property across elements, pages, and composite styles.
 *
 * Both axes travel together: a colour cascade that forgot the number axis would
 * re-materialise every radius in the wrong density on the way past.
 */
function switchAxisMode(doc: DesignDocument, axis: ModeAxis, target: string): DesignDocument {
  if (activeOf(doc, axis) === target) return doc;

  const activeTheme = axis === "color" ? target : getActiveTheme(doc);
  const activeNumberMode = axis === "number" ? target : getActiveNumberMode(doc);

  const nextTokens = doc.tokens ?? [];
  const nextStyles = cascadeTokensIntoStyles(doc.styles || [], nextTokens, activeTheme, undefined, activeNumberMode);
  const tables = styleTables({ tokens: nextTokens, styles: nextStyles });

  const nextPages = (doc.pages || []).map((page) => {
    const children = page.children || [];
    let elementsChanged = false;
    const updatedChildren = children.map((el) => {
      const next = syncDualStorage(el, tables, activeTheme, activeNumberMode);
      if (next !== el) elementsChanged = true;
      return next;
    });
    return {
      ...page,
      children: elementsChanged ? relayoutDocumentTree(updatedChildren) : updatedChildren
    };
  });

  const next: DesignDocument = { ...doc, styles: nextStyles, pages: nextPages };
  if (axis === "color") next.activeTheme = target;
  else next.activeNumberMode = target;
  return next;
}

/** Switches the active COLOUR mode of the document (e.g. "default" <-> "dark"). */
export function switchDocumentTheme(doc: DesignDocument, targetTheme: string): DesignDocument {
  return switchAxisMode(doc, "color", targetTheme);
}

/** Switches the active NUMBER mode of the document (e.g. "default" <-> "compact"). */
export function switchDocumentNumberMode(doc: DesignDocument, targetNumberMode: string): DesignDocument {
  return switchAxisMode(doc, "number", targetNumberMode);
}

/**
 * Resolves the inherited mode of one axis for an element by traversing up its
 * ancestor tree. If an ancestor container explicitly overrides the axis' field,
 * that mode is inherited. Otherwise, falls back to the document's active mode for
 * that axis.
 *
 * An INSTANCE inherits from its master as well as from its ancestors: the master
 * is authored under a mode of its own, and until the instance declares one that
 * is what it renders as. The inspector's "Inherited" row reads this number, so
 * reporting only the ancestor's left the menu naming a mode the canvas was not
 * painting.
 */
function getElementInheritedMode(doc: DesignDocument, elementId: string, axis: ModeAxis): string {
  const activePage = (doc.pages || []).find((p) => p.id === doc.activePageId) || doc.pages?.[0];
  const roots = activePage?.children || getActivePage(doc).children || [];
  const fallback = axis === "color" ? getActiveTheme(doc) : getActiveNumberMode(doc);
  const field = AXES[axis].field;

  function findInherited(elements: DesignElement[], parentMode: string): string | null {
    for (const el of elements) {
      if (el.id === elementId) {
        if (el.type !== "instance") return parentMode;
        const master = findMasterComponent(doc, (el as InstanceElement).componentId);
        return master?.[field] || parentMode;
      }
      if (isContainer(el) && el.children && el.children.length > 0) {
        const nextMode = el[field] || parentMode;
        const found = findInherited(el.children, nextMode);
        if (found !== null) return found;
      }
    }
    return null;
  }

  const result = findInherited(roots, fallback);
  return result ?? fallback;
}

export function getElementInheritedTheme(doc: DesignDocument, elementId: string): string {
  return getElementInheritedMode(doc, elementId, "color");
}

export function getElementInheritedNumberMode(doc: DesignDocument, elementId: string): string {
  return getElementInheritedMode(doc, elementId, "number");
}

/**
 * Sets or clears one axis' override on a container element, and synchronizes its
 * own properties and its subtree with both effective modes.
 */
function setElementMode(
  element: DesignElement,
  axis: ModeAxis,
  mode: string | undefined,
  tables: StyleTables,
  inheritedTheme: string,
  inheritedNumberMode: string
): DesignElement {
  const field = AXES[axis].field;
  const next = { ...element };
  const clean = mode?.trim();
  if (clean) next[field] = clean;
  else delete next[field];

  const effectiveTheme = next.themeMode || inheritedTheme;
  const effectiveNumberMode = next.numberMode || inheritedNumberMode || effectiveTheme;
  const synced = syncDualStorage(next, tables, effectiveTheme, effectiveNumberMode);
  return relayoutDocumentTree([synced])[0] ?? synced;
}

/**
 * Sets or clears the `themeMode` override on a container element, and synchronizes
 * its own properties and its subtree with the effective COLOUR mode.
 */
export function setElementThemeMode(
  element: DesignElement,
  themeMode: string | undefined,
  tables: StyleTables,
  inheritedTheme: string,
  inheritedNumberMode?: string
): DesignElement {
  return setElementMode(element, "color", themeMode, tables, inheritedTheme, inheritedNumberMode ?? inheritedTheme);
}

/**
 * Sets or clears the `numberMode` override on a container element, and synchronizes
 * its own properties and its subtree with the effective NUMBER mode.
 */
export function setElementNumberMode(
  element: DesignElement,
  numberMode: string | undefined,
  tables: StyleTables,
  inheritedTheme: string,
  inheritedNumberMode: string
): DesignElement {
  return setElementMode(element, "number", numberMode, tables, inheritedTheme, inheritedNumberMode);
}

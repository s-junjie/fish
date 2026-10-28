/**
 * Token and style references that nothing on the document backs.
 *
 * The engine paints the value materialised beside the id, so a dangling
 * reference looks correct on the canvas — it is only wrong the moment someone
 * edits the token, and then every edit detaches the layer instead of moving it.
 * Nothing else in the pipeline can see this: `normalize` keeps the id, the
 * renderer ignores it, and the importer works hard to avoid creating one. That
 * leaves a document that arrived from outside — an agent editing the JSON block,
 * a paste, a hand-written file — as exactly the case nobody reports.
 *
 * The two tables are separate: `tokenId` / `tokenBindings` name a `doc.tokens[]`
 * entry, `*StyleId` names a `doc.styles[]` entry. An id found in the OTHER table
 * is an error, not a warning — it means a writer put the entry in the wrong
 * table, and no edit of that entry will ever reach the layer it claims to own.
 *
 * There is no compatibility window: the old spellings (a `number` style, a
 * style's own `modes`) are dropped by `normalize` WITH a repair, and a token
 * reference pointed at a style is an error from the first load.
 *
 * A token whose value does not fit its `type` is NOT reported here: `normalize`
 * drops the entry and records a repair (plan §5 invariant 4), and a repair that
 * is shown is a failure the author acts on. Reporting the same defect here as an
 * error would give load and `check` two answers for one mistake.
 *
 * A reference to nothing at all stays a warning: the document still renders.
 * A check that failed on a resolvable-looking document would be wrong about the
 * one thing it can prove.
 */

import type { CompileDiagnostic } from "./compile";
import { getActivePage } from "./dsl/types";
import type { DesignDocument, DesignElement, DesignStyle, Effect, TextElement } from "./dsl/types";
import { flattenElements } from "./geometry/tree-ops";

const BASE_MODE = "default";

type Ref = { id: string; where: string };
type RefKind = "token" | "style";

/**
 * A paint, a stroke or a stroke's nested paint — all three can carry the id, and
 * a gradient carries one per stop. A stop is a colour a token can move on its
 * own, so it is a reference in its own right rather than part of the layer's.
 */
const paintRefs = (paint: unknown, where: string): Ref[] => {
  if (!paint || typeof paint !== "object") return [];
  const refs: Ref[] = [];
  const own = (paint as { tokenId?: unknown }).tokenId;
  if (typeof own === "string" && own) refs.push({ id: own, where });
  const stops = (paint as { stops?: unknown }).stops;
  if (Array.isArray(stops)) {
    stops.forEach((stop, i) => {
      const id = stop && typeof stop === "object" ? (stop as { tokenId?: unknown }).tokenId : undefined;
      if (typeof id === "string" && id) refs.push({ id, where: `${where} stop ${i + 1}` });
    });
  }
  return refs;
};

const effectTokens = (effect: Effect): string[] => {
  const tokens: string[] = [];
  const id = (effect as { tokenId?: string }).tokenId;
  if (typeof id === "string" && id) tokens.push(id);
  for (const bound of Object.values(((effect as { tokenBindings?: Record<string, string> }).tokenBindings) ?? {})) {
    if (typeof bound === "string" && bound) tokens.push(bound);
  }
  return tokens;
};

/** A layer's own references, in the order a reader would look for them. */
function elementRefs(el: DesignElement): Array<Ref & { kind: RefKind }> {
  const refs: Array<Ref & { kind: RefKind }> = [];

  (el.fills ?? []).forEach((paint, i) => {
    for (const ref of paintRefs(paint, `Fill ${i + 1}`)) refs.push({ ...ref, kind: "token" });
  });

  (el.strokes ?? []).forEach((stroke, i) => {
    for (const ref of paintRefs(stroke, `Stroke ${i + 1}`)) refs.push({ ...ref, kind: "token" });
    for (const ref of paintRefs(stroke.paint, `Stroke ${i + 1}`)) refs.push({ ...ref, kind: "token" });
  });

  (el.effects ?? []).forEach((effect, i) => {
    for (const id of effectTokens(effect)) refs.push({ id, where: `Effect ${i + 1}`, kind: "token" });
  });

  for (const [prop, id] of Object.entries(el.tokenBindings ?? {})) {
    if (typeof id === "string" && id) refs.push({ id, where: prop, kind: "token" });
  }

  for (const field of ["fillStyleId", "strokeStyleId", "effectStyleId"] as const) {
    const id = el[field];
    if (typeof id === "string" && id) refs.push({ id, where: field, kind: "style" });
  }
  if (el.type === "text") {
    const text = el as TextElement;
    if (typeof text.textStyleId === "string" && text.textStyleId) {
      refs.push({ id: text.textStyleId, where: "textStyleId", kind: "style" });
    }
    for (const [prop, id] of Object.entries(text.style?.tokenBindings ?? {})) {
      if (typeof id === "string" && id) refs.push({ id, where: `style.${prop}`, kind: "token" });
    }
  }

  return refs;
}

/** A style's own references: a style may follow a token the same way a layer does. */
function styleRefs(style: DesignStyle): Ref[] {
  const refs: Ref[] = [];

  if (style.styleType === "paint") {
    style.paints.forEach((paint, i) => {
      for (const ref of paintRefs(paint, `paint ${i + 1}`)) refs.push(ref);
    });
  } else if (style.styleType === "stroke") {
    style.strokes.forEach((stroke, i) => {
      for (const ref of paintRefs(stroke, `stroke ${i + 1}`)) refs.push(ref);
      for (const ref of paintRefs(stroke.paint, `stroke ${i + 1}`)) refs.push(ref);
    });
  } else if (style.styleType === "effect") {
    style.effects.forEach((effect, i) => {
      for (const id of effectTokens(effect)) refs.push({ id, where: `effect ${i + 1}` });
    });
  } else if (style.styleType === "text") {
    for (const [prop, id] of Object.entries(style.style?.tokenBindings ?? {})) {
      if (typeof id === "string" && id) refs.push({ id, where: `style.${prop}` });
    }
  }

  return refs;
}

export function validateTokenRefs(doc: DesignDocument): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  const styles = doc.styles ?? [];
  const tokens = doc.tokens ?? [];
  const styleIds = new Set(styles.map((style) => style.id));
  const tokenIds = new Set(tokens.map((token) => token.id));
  const colorModeIds = new Set((doc.modes && doc.modes.length > 0 ? doc.modes : [{ id: BASE_MODE }]).map((mode) => mode.id));
  const numberModeIds = new Set(
    (doc.numberModes && doc.numberModes.length > 0 ? doc.numberModes : [{ id: BASE_MODE }]).map((mode) => mode.id)
  );
  const listing = (ids: Set<string>) => [...ids].map((id) => `"${id}"`).join(", ");

  /**
   * One message per missing id, naming every place it was asked for.
   *
   * A card whose fill and stroke both follow one deleted colour is one mistake,
   * and two identical paragraphs would read as two — but naming only the first
   * place leaves the author fixing one and finding the other on the next run.
   */
  const group = (refs: Array<Ref & { kind: RefKind }>): Map<string, { kind: RefKind; where: string }> => {
    const byId = new Map<string, { kind: RefKind; where: string }>();
    for (const { id, where, kind } of refs) {
      const hit = byId.get(id);
      if (!hit) byId.set(id, { kind, where });
      else if (!hit.where.split(" and ").includes(where)) hit.where = `${hit.where} and ${where}`;
    }
    return byId;
  };

  /** An id that exists, but in the other table: a writer put it on the wrong side. */
  const crossTable = (
    id: string,
    where: string,
    owner: string,
    kind: RefKind,
    elementId?: string
  ) => {
    const expected = kind === "token" ? "tokens" : "styles";
    const actual = kind === "token" ? "styles" : "tokens";
    const what = kind === "token" ? "a token reference" : "a style reference";
    out.push({
      level: "error",
      message: `${where} of "${owner}" references "${id}", which exists — but in doc.${actual}[], not doc.${expected}[]. ${what} only ever resolves against doc.${expected}[], so the layer keeps the value written beside it and no edit of that entry reaches it. Move the entry to doc.${expected}[] and point the reference there, or clear it.`,
      ...(elementId ? { elementId } : {})
    });
  };

  const dangling = (id: string, where: string, owner: string, kind: RefKind, elementId?: string) => {
    const table = kind === "token" ? "tokens" : "styles";
    out.push({
      level: "warning",
      message: `${where} of "${owner}" references "${id}", which no entry in doc.${table}[] backs. The layer keeps the value already written beside it, but editing that token will not reach it — add the entry, or clear the reference so the value is honestly local.`,
      ...(elementId ? { elementId } : {})
    });
  };

  const resolve = (refs: Array<Ref & { kind: RefKind }>, owner: string, elementId?: string) => {
    for (const [id, { kind, where }] of group(refs)) {
      const own = kind === "token" ? tokenIds : styleIds;
      const other = kind === "token" ? styleIds : tokenIds;
      if (own.has(id)) continue;
      if (other.has(id)) crossTable(id, where, owner, kind, elementId);
      else dangling(id, where, owner, kind, elementId);
    }
  };

  // `activeTheme` naming a mode the document does not declare is the reason a
  // whole palette can look wrong with every token individually correct.
  if (doc.activeTheme && !colorModeIds.has(doc.activeTheme)) {
    out.push({
      level: "warning",
      message: `activeTheme is "${doc.activeTheme}", which doc.modes[] does not declare (it has ${listing(colorModeIds)}). Every colour token falls back to its base value, so the document renders as one mode while claiming another.`
    });
  }

  if (doc.activeNumberMode && !numberModeIds.has(doc.activeNumberMode)) {
    out.push({
      level: "warning",
      message: `activeNumberMode is "${doc.activeNumberMode}", which doc.numberModes[] does not declare (it has ${listing(numberModeIds)}). Every number token falls back to its base value, so the document renders as one density while claiming another.`
    });
  }

  for (const token of tokens) {
    if (styleIds.has(token.id)) {
      out.push({
        level: "error",
        message: `"${token.id}" is declared in BOTH doc.tokens[] and doc.styles[] ("${token.name}"). Every reference to it becomes ambiguous, so whichever table a reader consults decides what the document means. Give one of the two a new id.`
      });
    }
    // A token's per-mode values are keyed by the axis its TYPE belongs to: a
    // colour by `doc.modes`, a number by `doc.numberModes`.
    const isColor = token.type === "color";
    const axisIds = isColor ? colorModeIds : numberModeIds;
    const axisName = isColor ? "doc.modes[]" : "doc.numberModes[]";
    for (const mode of Object.keys(token.modes ?? {})) {
      if (axisIds.has(mode)) continue;
      out.push({
        level: "warning",
        message: `Token "${token.name || token.id}" has a value for mode "${mode}", which ${axisName} does not declare (it has ${listing(axisIds)}). Nothing can select that mode, so the value is unreachable.`
      });
    }
  }

  for (const style of styles) {
    resolve(
      styleRefs(style).map((ref) => ({ ...ref, kind: "token" as const })),
      style.name || style.id
    );
  }

  const pages = doc.pages && doc.pages.length > 0 ? doc.pages : [{ children: getActivePage(doc).children }];
  for (const page of pages) {
    for (const el of flattenElements(page.children ?? [])) {
      resolve(elementRefs(el), el.name || el.id, el.id);
      if (el.themeMode && !colorModeIds.has(el.themeMode)) {
        out.push({
          level: "warning",
          message: `"${el.name || el.id}" sets themeMode "${el.themeMode}", which doc.modes[] does not declare, so its subtree renders the base colour values.`,
          elementId: el.id
        });
      }
      if (el.numberMode && !numberModeIds.has(el.numberMode)) {
        out.push({
          level: "warning",
          message: `"${el.name || el.id}" sets numberMode "${el.numberMode}", which doc.numberModes[] does not declare, so its subtree renders the base number values.`,
          elementId: el.id
        });
      }
    }
  }

  return out;
}

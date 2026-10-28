import type { DesignDocument, DesignElement, Paint } from "../dsl/types";
import { getActivePage } from "../dsl/types";
import { findElementById } from "../geometry/tree-ops";
import { applyOps } from "../ops/apply-ops";
import { normalizeMacroOps } from "./suggested-ops";
import type { SuggestedMacroOp } from "./types";

/**
 * One line of the review card: a property that the suggested ops actually move.
 *
 * `key` is a stable identifier rather than prose so the panel can look the label
 * up in i18n; the core has no locale.
 */
export interface CommentDiffRow {
  key: string;
  before: string;
  after: string;
}

const NUMERIC_KEYS = ["x", "y", "width", "height", "rotation", "opacity"] as const;
const STYLE_KEYS = ["borderRadius", "cornerRadius", "fontSize", "fontWeight", "fontFamily"] as const;
const TEXT_KEYS = ["characters"] as const;

function fmtNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function fmtPaintStack(paints: Paint[] | undefined): string {
  if (!paints || paints.length === 0) return "—";
  const visible = paints.filter((p) => p.enabled !== false);
  if (visible.length === 0) return "—";
  const first = visible[visible.length - 1] as Paint & { color?: string };
  if (first.type === "solid" && typeof first.color === "string") return first.color.toUpperCase();
  return first.type;
}

function readField(el: DesignElement, key: string): string | undefined {
  const record = el as unknown as Record<string, unknown>;
  const raw = record[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") return fmtNumber(raw);
  if (typeof raw === "string" || typeof raw === "boolean") return String(raw);
  if (key === "fills" || key === "strokes") return fmtPaintStack(raw as Paint[]);
  return undefined;
}

/** A value that is present on neither side is not a change worth a row. */
function pushRow(
  rows: CommentDiffRow[],
  el: DesignElement | null,
  next: DesignElement | null,
  key: string
): void {
  const before = el ? readField(el, key) : undefined;
  const after = next ? readField(next, key) : undefined;
  if (before === after) return;
  if (before === undefined && after === undefined) return;
  rows.push({ key, before: before ?? "—", after: after ?? "—" });
}

/**
 * What the ops would change, read off the document rather than off the op list.
 *
 * Applying them to a copy and diffing the target element is the only reading
 * that survives every spelling an op may use (`cornerRadius` vs `border-radius`,
 * `value` vs `props`, CSS shorthand, tokens): the op runtime already resolves
 * all of it, and a second resolver here would be a second set of rules to keep
 * in step with it.
 */
export function computeSuggestionDiff(
  doc: DesignDocument,
  target: { pageId?: string; elementId?: string },
  ops: SuggestedMacroOp[]
): CommentDiffRow[] {
  if (!target.elementId || ops.length === 0) return [];
  const page = doc.pages.find((p) => p.id === target.pageId) ?? getActivePage(doc);
  // `applyOps` writes the ACTIVE page, and a comment may be on another one.
  const scoped: DesignDocument = { ...doc, activePageId: page.id };
  const before = findElementById(page.children, target.elementId);
  if (!before) return [];

  const applied = applyOps(scoped, normalizeMacroOps(ops));
  if (!applied.changed) return [];
  const after = findElementById(getActivePage(applied.doc).children, target.elementId);
  if (!after) return [];

  const rows: CommentDiffRow[] = [];
  for (const key of NUMERIC_KEYS) pushRow(rows, before, after, key);
  for (const key of STYLE_KEYS) pushRow(rows, before, after, key);
  for (const key of TEXT_KEYS) pushRow(rows, before, after, key);
  pushRow(rows, before, after, "fills");
  pushRow(rows, before, after, "strokes");
  pushRow(rows, before, after, "name");
  return rows;
}

/**
 * The element ids the ops touch, for the canvas's suggested outline.
 *
 * Read from the op list rather than from the diff: an op that moves a child or
 * inserts a sibling still changes the canvas, and a diff of the commented layer
 * would miss it.
 */
export function suggestionElementIds(ops: SuggestedMacroOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    const id = (op.id as string) || (op.targetId as string);
    if (id) ids.add(id);
  }
  return [...ids];
}

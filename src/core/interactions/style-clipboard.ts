import {
  BlendMode,
  ColorFilter,
  CornerRadius,
  DesignDocument,
  DesignElement,
  Effect,
  PaintStack,
  Stroke,
  TextElement,
  TextStyle,
  updateActivePageElements
} from "../dsl/types";
import { deepEqual } from "../deep-equal";
import { editableIds } from "../geometry/lock";
import { mapElements } from "../geometry/tree-ops";
import { relayoutDocumentTree } from "../compile";
import { isStoredNode, resolveInstanceSelection } from "./instance-resolve";
import { overrideDerivedNodes } from "./instance-overrides";

/**
 * Figma's "properties": everything about how a layer looks, and nothing about
 * where it is or what it is. Geometry, name, children, layout and visibility stay
 * behind — a copy/paste style moves paint from one layer onto another, it never
 * rebuilds a layer.
 *
 * Every key is optional and PRESENCE is the signal (`fills: []` is a decision —
 * "no fill" — while an absent `fills` means the source had no opinion). Applying
 * the payload therefore writes exactly the keys the source carried, which is the
 * same rule the DSL itself follows (LESSONS §38).
 */
export interface CopiedStyle {
  fills?: PaintStack;
  fillEnabled?: boolean;
  fillStyleId?: string;
  stroke?: Stroke;
  strokes?: Stroke[];
  strokeStyleId?: string;
  effects?: Effect[];
  effectStyleId?: string;
  adjust?: ColorFilter;
  blendMode?: BlendMode;
  opacity?: number;
  borderRadius?: CornerRadius;
  /** Text only: typography travels with the paint that shows it. */
  textStyle?: TextStyle;
  textStyleId?: string;
}

const STYLE_FIELDS = [
  "fills",
  "fillEnabled",
  "fillStyleId",
  "stroke",
  "strokes",
  "strokeStyleId",
  "effects",
  "effectStyleId",
  "adjust",
  "blendMode",
  "opacity",
  "borderRadius"
] as const satisfies ReadonlyArray<keyof CopiedStyle>;

/**
 * Read the properties off one layer. `null` when there is nothing to copy — a
 * resolved instance child has no stored style to read, and a text with no
 * `style` would otherwise contribute a payload that pastes nothing.
 */
export function copyStyleFrom(el: DesignElement | null | undefined): CopiedStyle | null {
  if (!el) return null;
  const out: CopiedStyle = {};
  let found = false;
  for (const field of STYLE_FIELDS) {
    const value = (el as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    (out as Record<string, unknown>)[field] = JSON.parse(JSON.stringify(value));
    found = true;
  }
  if (el.type === "text") {
    const text = el as TextElement;
    if (text.style) {
      out.textStyle = JSON.parse(JSON.stringify(text.style));
      found = true;
    }
    if (text.textStyleId) {
      out.textStyleId = text.textStyleId;
      found = true;
    }
  }
  return found ? out : null;
}

/**
 * Write copied properties onto one layer, leaving everything else alone. A text
 * layer takes the typography too; a shape ignores it, because a shape has no
 * `style` to write it into.
 */
export function applyCopiedStyle(el: DesignElement, copied: CopiedStyle): DesignElement {
  const next = { ...el } as unknown as Record<string, unknown>;
  for (const field of STYLE_FIELDS) {
    if (copied[field] === undefined) continue;
    next[field] = JSON.parse(JSON.stringify(copied[field]));
  }
  if (copied.textStyle && el.type === "text") {
    // Merge rather than replace: `TextStyle` is a whole record, and a source
    // that only authored a size must not blank the target's family.
    next.style = { ...(el as TextElement).style, ...copied.textStyle };
  }
  if (copied.textStyleId !== undefined && el.type === "text") {
    next.textStyleId = copied.textStyleId;
  }
  return next as unknown as DesignElement;
}

/**
 * The style clipboard. Module-scoped because it has exactly the same lifetime as
 * the editor's own file clipboard: it must survive a re-render and be reachable
 * from the keyboard and the context menu without threading a ref through both.
 */
let slot: CopiedStyle | null = null;

export const styleClipboard = {
  read: (): CopiedStyle | null => slot,
  write: (copied: CopiedStyle | null): void => {
    slot = copied;
  },
  has: (): boolean => slot !== null
};

/**
 * A selection split by where a pasted style's write has to land.
 *
 * A stored layer is rewritten in place. A layer the canvas paints inside an
 * instance is not in the tree at all — it is a resolved clone — so its style can
 * only become overrides on the instance that projects it. Both halves run through
 * the same rules, and that is why this cannot be `editableIds` alone: it keeps an
 * id with no element behind it on purpose (such a clone is still draggable through
 * its override path), so the lock on one is invisible to it and the two halves
 * would disagree about a locked target.
 */
export interface PasteStyleTargets {
  /** Rewritten in place: the document tree stores them. */
  stored: Set<string>;
  /** Only painted, so the write becomes overrides on their instance. */
  derived: string[];
}

export function pasteStyleTargets(
  doc: DesignDocument,
  elements: DesignElement[],
  selectedIds: Set<string>
): PasteStyleTargets {
  const stored = new Set<string>();
  const derived: string[] = [];
  for (const id of editableIds(elements, selectedIds)) {
    if (isStoredNode(doc, id)) {
      stored.add(id);
      continue;
    }
    const sel = resolveInstanceSelection(doc, id);
    // `overridable` is false when the node is reached through an instance crossing
    // no path can name, so an override keyed on it has nowhere to live; a locked
    // clone is out for the reason a locked layer always is.
    if (!sel || !sel.overridable || sel.node.locked === true) continue;
    derived.push(id);
  }
  return { stored, derived };
}

/**
 * The paste-properties transaction in full: `copied` onto every target in the
 * selection, as ONE document edit. `null` when nothing would change — a caller
 * committing that would leave an undo step that does what it says and no more.
 *
 * An override is a DIFF against the master, so a payload field that already
 * matches stores nothing and the layer keeps following the master for it — the
 * same rule the inspector's own fields follow.
 */
export function applyCopiedStyleTo(
  doc: DesignDocument,
  elements: DesignElement[],
  selectedIds: Set<string>,
  copied: CopiedStyle
): DesignDocument | null {
  const { stored, derived } = pasteStyleTargets(doc, elements, selectedIds);
  if (stored.size === 0 && derived.length === 0) return null;

  let wroteTree = false;
  const nextElements = mapElements(elements, (el) => {
    if (!stored.has(el.id)) return el;
    const next = applyCopiedStyle(el, copied);
    if (deepEqual(next, el)) return el;
    wroteTree = true;
    return next;
  });
  // A pasted typeface re-measures every text that took it, and only a layout pass
  // writes the new height back. Skipped when the tree did not move: the pass
  // rebuilds the array, so running it anyway would report a change that is not one.
  const base = wroteTree
    ? updateActivePageElements(doc, relayoutDocumentTree(nextElements))
    : doc;
  const overridden =
    derived.length > 0
      ? overrideDerivedNodes(base, derived, (el) => applyCopiedStyle(el, copied))
      : null;
  if (!wroteTree && !overridden) return null;
  return overridden ? overridden.doc : base;
}

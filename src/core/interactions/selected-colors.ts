import { ColorToken, DesignDocument, DesignElement, InstanceElement, Paint, PaintStyle, Stroke, getActivePage } from "../dsl/types";
import { effectiveStrokes, topLayer, topPaint } from "../dsl/paint-stack";
import { parseColorAlpha } from "../geometry/color-utils";
import { buildCssGradient, isGradientPaint } from "../geometry/gradient-utils";
import { patternCssBackground } from "../geometry/pattern-tile";
import { childrenOf, flattenElements, mapElements } from "../geometry/tree-ops";
import { InstanceBox, resolveInstanceBox } from "./instance-inherit";
import { findMasterComponent } from "./component-inventory";
import { InstanceSelection, instanceOverridePatch, resolveInstanceChildren, resolveInstanceSelection } from "./instance-resolve";


export interface SelectedColor {
  /** Canonical `#rrggbb`, lowercased. The identity of the colour. */
  hex: string;
  alpha: number;
  /** How many layers paint this colour. Counts LAYERS, not paint layers. */
  count: number;
  /** Ids of the layers that carry it — what a bulk edit writes to. Inside an
   *  instance these are RESOLVED ids the document does not store; the write
   *  turns them into overrides (see `applyPaintToSelection`). */
  elementIds: string[];
  /** Optional channel if known, kept for backwards compatibility. */
  channel?: PaintChannel;
  /** A gradient or a pattern is ONE entry however many colours it has, because
   *  the strip edits the whole paint rather than one colour inside it. */
  kind: "solid" | "gradient" | "pattern";
  /**
   * The layer as the document stores it — the value the editor opens on.
   */
  paint: Paint;
  /** The token id if this solid paint is bound to a color token. */
  tokenId?: string;
}

const norm = (hex: string) => hex.toLowerCase();

/** The two paint stacks a colour can be read from and written to. */
export type PaintChannel = "fill" | "stroke";

/**
 * The instance's resolved box, or null when the layer is not an instance (or its
 * master is gone and there is nothing to inherit from).
 */
function inheritedBox(doc: DesignDocument, el: DesignElement): InstanceBox | null {
  if (el.type !== "instance") return null;
  const inst = el as InstanceElement;
  const master = findMasterComponent(doc, inst.componentId);
  if (!master) return null;
  return resolveInstanceBox(inst, master);
}

/** The fill stack a layer paints with — an instance's, where it inherits them. */
function fillsOf(doc: DesignDocument, el: DesignElement): Paint[] | undefined {
  const box = inheritedBox(doc, el);
  return box ? box.fills : el.fills;
}

function strokesOf(el: DesignElement): Stroke[] | undefined {
  return effectiveStrokes(el);
}

function strokePaintOf(stroke: Stroke): Paint {
  // A row's colour token is `tokenId` (and the paint's own). A stroke row has no
  // style pointer at all — the four style kinds are independent.
  if (stroke.paint) return stroke.paint;
  return { type: "solid", color: stroke.color || "#000000", tokenId: stroke.tokenId };
}

export function collectSelectedColors(
  doc: DesignDocument,
  elements: DesignElement[]
): SelectedColor[] {
  const byKey = new Map<string, SelectedColor>();

  const record = (key: string, seed: SelectedColor, elementId: string) => {
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...seed, elementIds: [elementId] });
      return;
    }
    if (!existing.elementIds.includes(elementId)) {
      existing.elementIds.push(elementId);
      existing.count = existing.elementIds.length;
    }
  };

  const visit = (el: DesignElement) => {
    if (el.visible !== false) {
      for (const channel of ["fill", "stroke"] as const) {
        const paint =
          channel === "fill" ? topPaint(fillsOf(doc, el)) : topPaint(strokesOf(el)?.map(strokePaintOf));
        if (!paint) continue;
        if (paint.type === "solid") {
          const { hex6, alphaPct } = parseColorAlpha(paint.color);
          const tokenId = paint.tokenId;
          const key = tokenId ? `token:${tokenId}` : `solid:${norm(hex6)}`;
          record(
            key,
            { hex: norm(hex6), alpha: alphaPct, count: 1, elementIds: [], channel, kind: "solid", paint, tokenId },
            el.id
          );
        } else if (isGradientPaint(paint)) {
          const css = buildCssGradient(paint);
          record(
            `gradient:${css}`,
            { hex: css, alpha: 100, count: 1, elementIds: [], channel, kind: "gradient", paint },
            el.id
          );
        } else if (paint.type === "pattern") {
          const css = patternCssBackground(paint);
          record(
            `pattern:${paint.alignment ?? "start"}|${paint.tileType ?? "rectangular"}|${css}`,
            { hex: css, alpha: 100, count: 1, elementIds: [], channel, kind: "pattern", paint },
            el.id
          );
        }
      }
    }
    for (const child of childrenOf(el)) visit(child);
    if (el.type === "instance") {
      const inst = el as InstanceElement;
      const master = findMasterComponent(doc, inst.componentId);
      if (master) for (const child of resolveInstanceChildren(inst, master)) visit(child);
    }
  };

  for (const el of elements) visit(el);

  return [...byKey.values()].sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
}

/**
 * Compositing fields a paint LAYER owns, which an edit of the paint must not clobber.
 *
 * `adjust` is not one of them: only an image layer has one, and an image is
 * refused before this is reached.
 */
const LAYER_FLAGS = ["blendMode", "opacity", "enabled"] as const;

/**
 * The edited paint wearing the target LAYER's compositing, not the edited-on one's.
 *
 * The fields have to be deleted when the target layer does not set them: the paint
 * the editor returns is the seed layer's, with its own opacity, and leaving that on
 * would silently give a layer an opacity it never had.
 */
function withLayerFlags(paint: Paint, layer: Paint): Paint {
  const next = { ...paint } as Record<string, unknown>;
  for (const flag of LAYER_FLAGS) {
    if (layer[flag] === undefined) delete next[flag];
    else next[flag] = layer[flag];
  }
  return next as unknown as Paint;
}

/**
 * Rewrite one entry of the palette across every layer of the DOCUMENT that has it.
 *
 * Takes the **whole tree**, not the selection, and returns the whole tree. An
 * earlier version was handed the selected elements and its result was committed as
 * the page's element list, so changing a colour on a two-layer selection deleted the
 * other three layers from the document — the selection's own palette editing was
 * quietly the most destructive command in the app. `mapElements` walks into
 * containers, so a nested layer is matched by its id like any other, and anything
 * not in `elementIds` is returned by reference and left alone.
 *
 * Writes the top layer only, for the same reason the strip reads it: changing a
 * hidden lower layer would change nothing visible while reporting a change.
 *
 * Each layer keeps ITS OWN `enabled` / `blendMode` / `opacity`, because an entry is
 * one entry by what it *looks* like: three layers can share a gradient and differ
 * only in opacity, and editing the stops must not flatten that to the first one's.
 * An image is refused — it has no colour of its own to replace — as is a paint of
 * a different kind than the layer it would land on.
 *
 * Ids the tree does not hold are the projected layers inside an instance, and no
 * amount of mapping reaches them: they are written as OVERRIDES on the instance
 * that owns them, through the same construction the inspector's element updater
 * uses. An id that resolves to neither a stored layer nor an instance child is
 * dropped, so a stale entry rewrites nothing rather than the wrong thing.
 */
export function paintMatchesTarget(paint: Paint | undefined, target: SelectedColor): boolean {
  if (!paint) return false;
  if (target.tokenId) {
    return paint.tokenId === target.tokenId;
  }
  if (paint.tokenId) return false;

  if (target.kind === "solid") {
    if (paint.type !== "solid") return false;
    const { hex6 } = parseColorAlpha(paint.color);
    return norm(hex6) === target.hex;
  }
  if (target.kind === "gradient") {
    if (!isGradientPaint(paint)) return false;
    return buildCssGradient(paint) === target.hex;
  }
  if (target.kind === "pattern") {
    if (paint.type !== "pattern") return false;
    return patternCssBackground(paint) === target.hex;
  }
  return false;
}

export function applyPaintToSelection(
  doc: DesignDocument,
  elements: DesignElement[],
  target: SelectedColor,
  nextPaint: Paint,
  opts?: { allowKindChange?: boolean }
): DesignElement[] {
  if (nextPaint.type === "image") return elements;
  const ids = new Set(target.elementIds);
  if (!ids.size) return elements;

  const edit = (el: DesignElement): DesignElement => {
    let res = el;
    const currentFill = topPaint(fillsOf(doc, res));
    if (paintMatchesTarget(currentFill, target)) {
      res = replaceTopFill(doc, res, nextPaint, opts?.allowKindChange === true);
    }
    const strokes = strokesOf(res);
    const topStrokeLayer = strokes && strokes.length > 0 ? topLayer(strokes) : null;
    const currentStroke = topStrokeLayer ? strokePaintOf(topStrokeLayer) : undefined;
    if (paintMatchesTarget(currentStroke, target)) {
      res = replaceTopStroke(res, nextPaint, opts?.allowKindChange === true);
    }
    return res;
  };

  const stored = new Set(flattenElements(getActivePage(doc).children).map((el) => el.id));
  const selections = target.elementIds
    .filter((id) => !stored.has(id))
    .map((id) => resolveInstanceSelection(doc, id))
    .filter((sel): sel is InstanceSelection => sel !== null);
  const patch = instanceOverridePatch(selections, edit);

  return mapElements(elements, (el) => {
    const patched = patch(el);
    // An instance can be in the entry twice over — its own box and a child of
    // its own — and both writes have to land on the same element.
    return ids.has(el.id) ? edit(patched) : patched;
  });
}

/**
 * One layer's colour replaced by `nextPaint`, reading the stack the canvas paints:
 * an instance that inherits its background has no `fills` of its own, and an edit
 * to that colour has to become the explicit stack it was never storing.
 */
function replaceTopFill(
  doc: DesignDocument,
  el: DesignElement,
  nextPaint: Paint,
  allowKindChange = false
): DesignElement {
  const fills = fillsOf(doc, el);
  const current = topPaint(fills);
  if (!fills || !current || current.type === "image") return el;
  if (current.type !== nextPaint.type && !allowKindChange) return el;
  const index = fills.indexOf(current);
  if (index === -1) return el;
  const nextFills = fills.slice();
  nextFills[index] = withLayerFlags(nextPaint, current);
  return { ...el, fills: nextFills };
}

/** `applyPaintToSelection` for a solid entry, which is the one every caller had. */
export function applyColorToSelection(
  doc: DesignDocument,
  elements: DesignElement[],
  target: SelectedColor,
  nextHex: string
): DesignElement[] {
  if (target.kind !== "solid") return elements;
  const { hex6, alphaPct } = parseColorAlpha(nextHex);
  return applyPaintToSelection(doc, elements, target, {
    type: "solid",
    color: alphaPct === 100 ? hex6 : nextHex
  });
}

/**
 * One layer's top STROKE layer replaced, reading the same stack `collectSelectedColors`
 * reads and writing it back through the container the layer already uses.
 *
 * Both forms are kept in step — `color` and `paint` together, the way
 * `StrokeSection` writes a hex — because a reader that took only one of them is
 * how an imported shorthand outline came back reporting no colour at all.
 */
function replaceTopStroke(el: DesignElement, nextPaint: Paint, allowKindChange = false): DesignElement {
  const strokes = strokesOf(el);
  if (!strokes || strokes.length === 0) return el;
  const layer = topLayer(strokes);
  if (!layer) return el;
  const current = strokePaintOf(layer);
  if (current.type === "image") return el;
  if (current.type !== nextPaint.type && !allowKindChange) return el;

  const next: Stroke = { ...layer };
  const compositing: Record<string, unknown> = next as unknown as Record<string, unknown>;
  const fromPaint = nextPaint as unknown as Record<string, unknown>;
  const fromLayer = layer as unknown as Record<string, unknown>;
  for (const flag of LAYER_FLAGS) {
    if (fromLayer[flag] === undefined) delete compositing[flag];
    else compositing[flag] = fromPaint[flag];
  }
  next.paint = nextPaint;
  if (nextPaint.type === "solid") {
    next.color = nextPaint.color;
    // A row's colour has ONE source: the value it paints (and the token that
    // value follows). There is no style pointer on a stroke row — the four style
    // kinds are independent — so the only link to write or clear is `tokenId`.
    if (nextPaint.tokenId) {
      next.tokenId = nextPaint.tokenId;
    } else {
      // A free colour owns the row: leave no token behind, or the next sync would
      // pull the colour back to the token it was detached from.
      delete next.tokenId;
    }
  }

  return { ...el, strokes: strokes.map((s) => (s === layer ? next : s)) };
}

/** The colour each swatch paints, for the strip's own background. */
export function selectedColorCss(color: SelectedColor): string {
  if (color.kind !== "solid") return color.hex;
  return color.alpha === 100 ? color.hex : `${color.hex}${Math.round((color.alpha / 100) * 255).toString(16).padStart(2, "0")}`;
}

/**
 * The style a colour comes from, when every layer carrying it is bound to one.
 *
 * Only then: two layers sharing a hex but bound to *different* styles are two
 * design decisions that happen to agree, and a row claiming one name for them
 * would be choosing for the user which of the two they are editing.
 *
 * Read from the DOCUMENT, not from the selection: the palette walks subtrees, so
 * the layers carrying a colour are usually children the selection array does not
 * hold — asking only the selected nodes is how a bound style on a child came back
 * as a bare hex that could be edited straight out from under it. An instance root
 * is read the same way the FILL section reads it, through `resolveInstanceBox`:
 * an instance of a style-bound component is bound, whatever it stores.
 */
export function boundFillStyleFor(
  doc: DesignDocument,
  color: SelectedColor
): PaintStyle | null {
  if (color.kind !== "solid" || color.elementIds.length === 0) return null;
  const styles = (doc.styles || []).filter((s): s is PaintStyle => s.styleType === "paint");
  if (styles.length === 0) return null;
  const byId = new Map(flattenElements(getActivePage(doc).children).map((el) => [el.id, el]));
  let found: PaintStyle | null = null;
  for (const id of color.elementIds) {
    const el = byId.get(id);
    // An id the document does not hold is a resolved node inside an instance: it
    // has no binding of its own to read, so this row says nothing about styles.
    if (!el) return null;
    const box = inheritedBox(doc, el);
    const fillStyleId = box ? box.fillStyleId : el.fillStyleId;

    const currentFill = topPaint(fillsOf(doc, el));

    // Only a FILL can be owned by a paint style. A stroke is owned by its own
    // `strokeStyleId` (a stroke style) or by nothing — the kinds are independent.
    const checkedStyleIds: string[] = [];
    if (paintMatchesTarget(currentFill, color) && fillStyleId) checkedStyleIds.push(fillStyleId);
    if (checkedStyleIds.length === 0) return null;

    for (const styleId of checkedStyleIds) {
      const style = styles.find((s) => s.id === styleId);
      if (!style) return null;
      if (found && found.id !== style.id) return null;
      found = style;
    }
  }
  return found;
}

/**
 * The colour token a solid colour comes from, when every layer carrying it names that token.
 */
export function boundColorTokenFor(
  doc: DesignDocument,
  color: SelectedColor
): ColorToken | null {
  if (color.kind !== "solid" || !color.tokenId) return null;
  const token = (doc.tokens || []).find(
    (entry): entry is ColorToken => entry.type === "color" && entry.id === color.tokenId
  );
  return token ?? null;
}

import { Paint, Stroke } from "./types";

/**
 * Paint stacks (`fills`, `strokes`) are stored bottom-first: index 0 paints first,
 * so it ends up underneath. The Figma importer relies on the same order, and
 * `SvgElementRenderer` emits the array verbatim.
 *
 * The inspector must therefore list them top-first, or row order contradicts what
 * the canvas shows. Everything here works in that flipped "UI position" space and
 * converts back to storage indices, so callers never hand-roll the reversal.
 *
 * CSS `background` is top-first too, so an HTML/CSS export of a stack runs through
 * `cssPaintOrder` — index 0 of a paint stack is never the layer the eye sees.
 */

export interface StackRow<T> {
  item: T;
  index: number;
}

/** Storage order -> UI rows, top-most paint first. `index` stays the storage index. */
export function stackRows<T>(list: readonly T[] | undefined | null): StackRow<T>[] {
  if (!list || list.length === 0) return [];
  const rows: StackRow<T>[] = [];
  for (let i = list.length - 1; i >= 0; i--) rows.push({ item: list[i], index: i });
  return rows;
}

/**
 * Move the row at UI position `fromUi` so it lands at UI slot `insertBeforeUi`
 * (0..length, where `length` means "below the last row"). Returns a new array in
 * storage order. Dropping a row onto its own slot returns an equal copy.
 */
export function moveStackRow<T>(list: readonly T[], fromUi: number, insertBeforeUi: number): T[] {
  const ui = list.slice().reverse();
  if (fromUi < 0 || fromUi >= ui.length) return ui.reverse();
  const [moved] = ui.splice(fromUi, 1);
  const raw = insertBeforeUi > fromUi ? insertBeforeUi - 1 : insertBeforeUi;
  ui.splice(Math.max(0, Math.min(ui.length, raw)), 0, moved);
  return ui.reverse();
}

/** Insert slot for a pointer at `y`: the count of row midpoints at or above it. */
export function slotFromPointerY(centers: readonly number[], y: number): number {
  let slot = 0;
  while (slot < centers.length && y >= centers[slot]) slot++;
  return slot;
}

/** Top-most visible layer: what the eye sees, and the first entry CSS wants. */
export function topLayer<T extends { enabled?: boolean }>(
  list: readonly T[] | undefined | null
): T | undefined {
  if (!list || list.length === 0) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].enabled !== false) return list[i];
  }
  return list[list.length - 1];
}

/**
 * The strokes that actually render. Lives beside `topLayer` because both answer
 * "which paint is the one the eye sees", and because a stroke override has to be
 * compared layer by layer: a reader that compared only the top layer called two
 * different stacks equal.
 */
export function effectiveStrokes(el: { strokes?: Stroke[] | null }): Stroke[] | undefined {
  return Array.isArray(el.strokes) && el.strokes.length > 0 ? el.strokes : undefined;
}

export function topPaint(list: readonly Paint[] | undefined | null): Paint | undefined {
  return topLayer(list);
}

/** Storage order -> CSS `background` order, which paints the top-most layer first. */
export function cssPaintOrder<T>(list: readonly T[]): T[] {
  return list.slice().reverse();
}

/**
 * Gradient, pattern and filter defs are keyed by a layer's position in the source
 * stack. Looking them up by a filtered index (enabled-only, instance override)
 * points at the wrong def as soon as any lower layer is hidden.
 */
export function paintLayerIndex<T>(source: readonly T[] | undefined, paint: T, fallback: number): number {
  const i = source ? source.indexOf(paint) : -1;
  return i >= 0 ? i : fallback;
}

/**
 * Does this stack carry a layer whose COLOUR varies across the element?
 *
 * The predicate behind whether the mask-mode control is worth offering. A solid
 * fill is one colour everywhere, so `luminance` reads a single number out of it
 * — which is what the element's `opacity` already says, and offers nothing that
 * `alpha` does not. A gradient and an image both vary, so for those the chosen
 * channel decides the SHAPE of the mask, not just its strength.
 */
export function maskChannelVaries(list: readonly Paint[] | undefined | null): boolean {
  return (list ?? []).some((f) => !!f && f.enabled !== false && f.type !== "solid");
}

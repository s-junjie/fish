import { DesignDocument, DesignElement, getActivePage } from "../dsl/types";
import { Rect } from "../geometry/bounds";
import { contentBounds, elementRotatedAABB } from "../geometry/element-bounds";
import { readingOrder } from "../geometry/reading-order";
import { findElementById, isContainer } from "../geometry/tree-ops";
import { resolveInstanceSelection } from "../interactions/instance-resolve";

/**
 * What makes a top-level element a slide.
 *
 * `html` is one because a framed page fills a screen by itself: without this it
 * would not be a slide, and a slide paints only its own root — so an embed
 * sitting beside artboards was not merely un-playable in presentation, it was
 * not painted at all.
 */
function isSlideCandidate(el: DesignElement): boolean {
  return (
    (isContainer(el) || el.type === "html") &&
    el.visible !== false &&
    (el.width ?? 0) > 0 &&
    (el.height ?? 0) > 0
  );
}

export interface PresentationFrame {
  id: string;
  /** The elements this slide paints. A single artboard, or the whole page. */
  elements: DesignElement[];
  /** World-space box to fit into the screen. */
  bounds: Rect;
}

/** Sentinel id for the synthetic slide a page with no artboards presents as. */
export const PAGE_FRAME_ID = "__page__";

/**
 * The slides of a document: one per top-level container (frame or component) or
 * `html` embed on the active page, in READING ORDER — rows top to bottom, and
 * within a row left to right, the way the canvas is laid out and the way a
 * presenter means them.
 *
 * Not the array order and not the layer panel's. `elements[]` is paint order and
 * the panel is that reversed, so both are a function of when things were added
 * rather than where they sit: nudge one artboard 40px to the left and a
 * presentation deck reshuffles itself. `readingOrder` is the one place that
 * decides, because a deck's order is a property of the page's geometry.
 *
 * A hidden candidate is not a slide. `visible:false` already means "does not
 * occupy layout", and a slide nobody can see is not one anybody meant to
 * present; including it would put a blank screen in the middle of the deck.
 *
 * A zero-area candidate is skipped for the same reason and by the same test: a
 * 0-width frame is a legal stored value (the normalizer clamps to `Math.max(0,
 * …)` rather than rejecting it), and as a slide it fits to 1:1 and shows an
 * empty screen with the counter still counting it.
 *
 * A page built without artboards still presents, as itself — one slide holding
 * every visible element on it. An empty page has no slides at all.
 */
export function presentationFrames(doc: DesignDocument): PresentationFrame[] {
  const elements = getActivePage(doc).children || [];
  const slides = slideOrder(elements);
  if (slides.length > 0) {
    return slides.map((el) => ({ id: el.id, elements: [el], bounds: elementRotatedAABB(el) }));
  }

  const page = contentBounds(elements);
  if (!page || page.width <= 0 || page.height <= 0) return [];
  return [{ id: PAGE_FRAME_ID, elements, bounds: page }];
}

/**
 * The top-level elements that will present, in the order they will present in.
 *
 * The deck's order is a property of the PAGE'S GEOMETRY, not of the array, and
 * this is the one place that decides it — so anything that has to line up with
 * the presentation has to ask this rather than read `elements`. That includes
 * the inspector: a slide's transition describes the next one IN THE DECK, which
 * is not the next one in the array once a designer has dragged a slide anywhere.
 */
export function slideOrder(elements: readonly DesignElement[]): DesignElement[] {
  const candidates = elements
    .filter(isSlideCandidate)
    .map((el) => ({ el, bounds: elementRotatedAABB(el) }));
  return readingOrder(candidates, (c) => c.bounds).map((c) => c.el);
}

/**
 * The slide a presenter would arrive on after `id`, in the same reading order
 * the deck plays in. Null for the last slide, for an id that is not a slide,
 * and for the synthetic page slide — which has no sibling to transition to.
 *
 * Both readers of a morph need this and must agree: the canvas draws the
 * pairing and the inspector lists it, and two copies of this lookup is how one
 * of them ends up naming a different next slide.
 */
export function nextSlideOf(frames: PresentationFrame[], id: string): DesignElement | null {
  const at = frames.findIndex((f) => f.elements.length === 1 && f.elements[0].id === id);
  return at >= 0 && at < frames.length - 1 ? frames[at + 1].elements[0] ?? null : null;
}

/**
 * Resolves the slide index to begin presenting from.
 *
 * If any element inside a top-level presentation frame (or an instance node)
 * is selected, returns that slide's index so presentation starts directly from
 * that frame. Falls back to index 0 when nothing is selected or no candidate matches.
 */
export function findPresentationSlideIndex(
  frames: PresentationFrame[],
  doc: DesignDocument,
  primarySelectedId: string | null
): number {
  if (!primarySelectedId) return 0;
  const ownerInstanceId = resolveInstanceSelection(doc, primarySelectedId)?.instanceId;
  const foundIdx = frames.findIndex((f) =>
    f.elements.some(
      (root) =>
        findElementById([root], primarySelectedId) !== null ||
        (Boolean(ownerInstanceId) && findElementById([root], ownerInstanceId!) !== null)
    )
  );
  return foundIdx >= 0 ? foundIdx : 0;
}

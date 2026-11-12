import type { DesignDocument, DesignElement } from "../dsl/types";
import {
  canContainerScroll,
  clampScrollOffset,
  hasScrollableOverflow,
  scrollableAncestors
} from "../geometry/scroll-bounds";
import { findElementAtPoint } from "../geometry/tree-hit";

/**
 * Where a wheel over a deck goes: a container's offset, the slide's own, or
 * nowhere.
 *
 * There is deliberately no "next slide" answer. A deck is watched at the same
 * size as its content, so a wheel over a slide is a request to see the rest of
 * THAT slide — advancing on the same gesture turned one flick over a long list
 * into a scroll, then a jump, then a different slide. Slides move on a click,
 * an arrow key or the deck's own controls.
 */
export type PresentWheelPlan =
  | { kind: "container"; id: string; x: number; y: number }
  | { kind: "slide"; y: number }
  | { kind: "none" };

export interface PresentWheelRequest {
  /** What the stage paints, with the deck's own offsets already applied. */
  elements: DesignElement[];
  doc?: DesignDocument;
  /** World-space point under the pointer. */
  point: { x: number; y: number };
  delta: { x: number; y: number };
  /**
   * The offsets the deck holds rather than the document — a deck scrolls the
   * copy it paints, so the element's own `scrollX`/`scrollY` is only the seed.
   */
  offsets: Readonly<Record<string, { x: number; y: number }>>;
  /** How far the slide itself is scrolled. */
  slideY: number;
  /** How far the slide can travel before its bottom edge reaches the screen. */
  maxSlideY: number;
}

export function planPresentWheel(request: PresentWheelRequest): PresentWheelPlan {
  const { elements, doc, point, delta, offsets } = request;
  const hit = findElementAtPoint(elements, point.x, point.y, { includeLocked: true });
  // An embedded page owns its own scroll: the deck has nothing to add to it, and
  // moving the slide on the same gesture would be the deck fighting the embed.
  if (!hit || hit.type === "html") return { kind: "none" };

  const candidates = scrollableAncestors(elements, hit, doc);
  for (const candidate of candidates) {
    const current = offsets[candidate.id] ?? { x: candidate.scrollX ?? 0, y: candidate.scrollY ?? 0 };
    const withScroll = { ...candidate, scrollX: current.x, scrollY: current.y };
    if (!canContainerScroll(withScroll, delta.x, delta.y, doc)) continue;
    const next = clampScrollOffset(
      withScroll as never,
      current.x + delta.x,
      current.y + delta.y,
      undefined,
      doc
    );
    if (next.scrollX !== current.x || next.scrollY !== current.y) {
      return { kind: "container", id: candidate.id, x: next.scrollX, y: next.scrollY };
    }
  }

  // A wheel at the end of a scrollable container stops there. Handing the
  // remainder to the slide — or the deck — is how a scroll becomes a jump.
  if (candidates.some((candidate) => hasScrollableOverflow(candidate, doc))) return { kind: "none" };

  if (request.maxSlideY > 0) {
    const y = Math.min(request.maxSlideY, Math.max(0, request.slideY + delta.y));
    if (y !== request.slideY) return { kind: "slide", y };
  }
  return { kind: "none" };
}

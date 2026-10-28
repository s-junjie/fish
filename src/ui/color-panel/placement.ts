import type { PaintKind } from "../paint-kind";

/** The panel's fixed width — the placement math and the root style must agree. */
export const COLOR_PANEL_WIDTH = 240;

/** Never cap the panel below this, or a short viewport hides the kind switcher. */
export const COLOR_PANEL_MIN_HEIGHT = 430;

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const BOTTOM_MARGIN = 20;

/** A nested picker has to clear the panel that hosts it, not the swatch inside it. */
const HOST_SELECTOR = "[data-style-picker-popover], [data-color-panel], [data-host-popover]";

export type PanelSide = "below" | "above";

export interface PanelDecision {
  anchor: HTMLElement;
  kind: PaintKind;
  side: PanelSide;
  offset: number;
}

export interface PanelPlacement {
  left: number;
  top: number;
  /** `null` is "no cap"; a number is the room this viewport leaves the body. */
  maxHeight: number | null;
  decision: PanelDecision;
}

export interface PlaceColorPanelArgs {
  anchor: HTMLElement;
  panel: HTMLElement;
  /** The body the side is chosen for: a taller body can need the other side. */
  kind: PaintKind;
  /** An image body absorbs the clamp itself — see the `maxHeight` note below. */
  isImage: boolean;
  /** The previous result, so a side decided once is not re-decided per measure. */
  previous: PanelDecision | null;
  viewport: { width: number; height: number };
}

/**
 * Where the panel goes, and how tall it may be.
 *
 * Side and offset are decided ONCE per (anchor, kind): re-deciding on every
 * measure made the panel teleport when a taller body arrived. Keeping the offset
 * (rather than an absolute `top`) keeps it tracking the anchor while a taller
 * body grows into free space; when neither side fits, the roomier one wins and
 * the body is capped and scrolls in place.
 */
export function placeColorPanel({
  anchor,
  panel,
  kind,
  isImage,
  previous,
  viewport
}: PlaceColorPanelArgs): PanelPlacement {
  const anchorRect = anchor.getBoundingClientRect();
  const host = anchor.closest(HOST_SELECTOR);
  const bounds = host ? host.getBoundingClientRect() : anchorRect;

  let left = bounds.left - COLOR_PANEL_WIDTH - ANCHOR_GAP;
  if (left < VIEWPORT_MARGIN) {
    left = Math.min(bounds.right + ANCHOR_GAP, viewport.width - COLOR_PANEL_WIDTH - VIEWPORT_MARGIN);
  }
  left = Math.max(VIEWPORT_MARGIN, left);

  // `scrollHeight` is the CONTENT height even once `maxHeight` clamps the box, so
  // the side decision cannot be poisoned by an earlier clamp.
  const contentHeight = panel.scrollHeight || panel.offsetHeight;
  const bottom = viewport.height - BOTTOM_MARGIN;
  const clampTop = (v: number) => Math.max(VIEWPORT_MARGIN, Math.min(v, bottom - COLOR_PANEL_MIN_HEIGHT));

  const kept = previous && previous.anchor === anchor && previous.kind === kind ? previous : null;
  const decision = kept ?? decideSide(anchor, anchorRect.top, contentHeight, kind, clampTop, bottom);

  const top = clampTop(anchorRect.top + decision.offset);
  const room = Math.max(COLOR_PANEL_MIN_HEIGHT, bottom - top);
  return {
    left,
    top,
    // An image body is a flex column whose axis list absorbs the clamp, so the
    // capped panel measures exactly `room` and the fit test would read that as a
    // fit, uncap, measure taller and flip back. Keep the cap and let the list
    // take the difference.
    maxHeight: isImage || contentHeight > room ? room : null,
    decision
  };
}

/**
 * Both sides scored by the height each can actually SHOW.
 *
 * Flipping to "above" only when the body fits there entirely left a swatch low
 * on the page on the "below" side with a minimum-height slot and a scrollbar
 * while the space above sat unused. A full fit either side wins outright; a tie
 * keeps "below", so the common case is unchanged.
 */
function decideSide(
  anchor: HTMLElement,
  anchorTop: number,
  contentHeight: number,
  kind: PaintKind,
  clampTop: (v: number) => number,
  bottom: number
): PanelDecision {
  const shown = (top: number) => Math.min(contentHeight, bottom - clampTop(top));
  const above = shown(anchorTop - contentHeight);
  const below = shown(anchorTop);
  // "above" pins the panel's bottom to the swatch, so the offset is the height it
  // will actually render at — not `contentHeight`, or a clamped panel would leave
  // that much dead space between its near edge and the swatch.
  return above > below
    ? { anchor, kind, side: "above", offset: -above }
    : { anchor, kind, side: "below", offset: 0 };
}

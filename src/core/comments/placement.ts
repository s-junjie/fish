/**
 * Where a comment popover sits relative to its pin.
 *
 * The popover is portalled to `<body>`, so it is placed in WINDOW coordinates
 * against the window box — not inside the canvas. A pin near the right rail or
 * the dock used to put the popover under chrome that paints above the canvas,
 * which made the composer unclickable; a pin near an edge put it outside the
 * clipping ancestor, which hid half of it. Both are the same missing step:
 * somebody has to decide, in window space, which side has room.
 */

export interface PinPoint {
  x: number;
  y: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface WindowBox {
  width: number;
  height: number;
}

export interface PopoverPlacement {
  left: number;
  top: number;
  /** Which side of the pin the panel opened on; drives the pop-in origin. */
  attachment: "right" | "left";
}

/**
 * Clearance between the pin and the card, measured from the pin's CENTRE.
 *
 * A pin is 24px across and wears a 2px ring, so anything under 14 overlaps the
 * marker itself — 12 put the card's edge on the badge's right edge and the
 * badge read as half hidden. 20 leaves 6px of air beside the ring.
 */
const GAP = 20;
const MARGIN = 8;

export function placeCommentPopover(
  pin: PinPoint,
  size: PopoverSize,
  viewport: WindowBox
): PopoverPlacement {
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN);

  // Right by default — the pin's own glyph stays visible beside the panel. It
  // flips only when the right side genuinely cannot hold the panel, and then the
  // result is clamped, because a panel that flips and still overflows has to end
  // up somewhere the user can reach.
  const wantRight = pin.x + GAP;
  const attachment: "right" | "left" = wantRight > maxLeft ? "left" : "right";
  const rawLeft = attachment === "right" ? wantRight : pin.x - GAP - size.width;

  return {
    left: Math.min(Math.max(MARGIN, rawLeft), maxLeft),
    // Top-aligned with the pin, pulled up by the panel's own padding so the
    // first message sits level with the glyph rather than below it.
    top: Math.min(Math.max(MARGIN, pin.y - 10), maxTop),
    attachment
  };
}

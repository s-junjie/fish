/**
 * The canvas's own palette — the colours the SVG overlays draw with.
 *
 * These are the same two accents the shell uses, and they mean the same two
 * things, but they cannot come from `tailwind.config.js`: they are SVG
 * presentation attributes (`stroke={…}`, `fill={…}`) and a token is a class.
 * So the values live here, once, instead of being pasted into forty call sites
 * across nine overlay files — where they had already drifted into three shades of
 * "the selection blue" before this module existed.
 *
 * The meanings are fixed and narrow:
 *
 *  - `CANVAS_SELECT` — an affordance that means *this is the thing under your
 *    pointer or the thing you have chosen*: selection outlines, drag ghosts,
 *    pen/vertex handles, the shape being drawn. Figma's blue.
 *  - `CANVAS_COMPONENT` — a component or a variant set. #B794FF, NOT the older
 *    #9747FF: that one measures 3.94:1 on the canvas and fails AA, and the panel
 *    has been drawing components in #B794FF all along — one meaning, two colours.
 *  - `CANVAS_ON_SELECT` — the ink that sits ON the selection blue (the armed
 *    vertex, the marker inside a selected handle). White, because it is the only
 *    value that reads against #3B82F6 at 4px.
 *
 * `ui-conventions.test.ts` allowlists this file by name, so a new ad-hoc hex in
 * an overlay fails the suite rather than quietly becoming a fourth meaning.
 */

/** Ocean Electric Blue: selection, drag, pen and vertex affordances. */
export const CANVAS_SELECT = "#1B72FF";

/** Component and variant-set chrome. AA on canvas; matches the inspector's mark. */
export const CANVAS_COMPONENT = "#B794FF";

/** Ink on top of {@link CANVAS_SELECT} — or on top of the smart-selection pink. */
export const CANVAS_ON_SELECT = "#FFFFFF";

/**
 * White as a MASK PAINT, not as ink.
 *
 * A luminance mask reads white as "keep this" and black as "cut it"; the two
 * fills in `CanvasDefs` / `mask-defs` are that vocabulary, not a colour anyone
 * sees. Named here anyway so the guard test can hold every canvas hex to this
 * file — a mask paint that drifts to #FAFAFA still cuts identically, but only by
 * accident, and the next reader has no way to tell the two apart.
 */
export const CANVAS_MASK_KEEP = "#FFFFFF";

/**
 * The unified geometry accent for snap alignment, smart-selection gap handles,
 * and distance measurement. Organic coral hue aligned with FISH branding.
 */
export const CANVAS_CORAL = "#FF5353";

/** Smart-selection alignment and gap handle accent. */
export const CANVAS_SMART_SELECT = CANVAS_CORAL;

/**
 * The MARGIN band's accent, and the grid cell preview's — named for what they
 * mean so the value can move without every reader chasing a colour name. The
 * cell preview is the same blue because it is the same statement seen from
 * inside a chosen container, drawn beside that container's own box; it inherits
 * the collision below rather than adding to it.
 *
 * Two candidates have been measured against the other canvas semantics, with
 * the colour story's own three tests:
 *
 *   |          | contrast | min ΔE00 | min hue | nearest          |
 *   |----------|----------|----------|---------|------------------|
 *   | #7A6BB5  | 3.89:1   | 16.1     | 4.1°    | COMPONENT violet |
 *   | #1B72FF  | 4.14:1   | 14.9     | 13.3°   | PREVIEW blue     |
 *
 * Neither clears that page's ≥30° same-family gate, which is why the margin band
 * is DASHED: treatment is the primary channel and this value is the third. What
 * separates them is which collision each carries — #7A6BB5 sits 4° from the
 * component violet, #1B72FF sits 13° from the pen's own rubber band and, more
 * to the point, IS the colour that means "chosen": during a scrub the selection
 * chrome stands down, so a blue band is briefly the only blue on the canvas and
 * reads as a selection that is not there.
 */
export const CANVAS_MARGIN = "#1B72FF";

/**
 * The one way to make a canvas paint translucent.
 *
 * Alpha cannot be a token — `fill` takes a string, not a class — and the four
 * sites that needed it each spelled a stock Tailwind hex inline instead
 * (`rgba(59, 130, 246, …)` is blue-500, not `CANVAS_SELECT`), which is why the
 * drop slot and the marquee were a slightly different blue from the selection
 * outline drawn one line away. Composing from the token above makes that
 * impossible to get wrong rather than merely discouraged.
 */
export function withAlpha(hex: string, alpha: number): string {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Black as the other half of the mask vocabulary — see {@link CANVAS_MASK_KEEP}. */
export const CANVAS_MASK_CUT = "#000000";

/** The measurement frame and distance line accent. */
export const CANVAS_MEASURE = CANVAS_CORAL;

/**
 * The pen's rubber band — the closed shape a drag will produce. Deliberately a
 * lighter blue than {@link CANVAS_SELECT}: it is a preview of a future stroke,
 * not a thing being selected.
 */
export const CANVAS_PREVIEW = "#5EA2FF";

/**
 * The dashed guides around a gradient's on-canvas handles, and an unselected
 * frame's title. A neutral that has to sit on ANY artwork without being read as
 * part of it.
 */
export const CANVAS_GUIDE = "#888888";

/**
 * The size badge's own three colours — the workbench's surface, ridge and ink,
 * restated as values because the badge is drawn INSIDE the SVG with no CSS to
 * inherit from. Same three, one meaning each; see `tailwind.config.js`.
 */
export const CANVAS_BADGE_SURFACE = "#1E1E1E";
export const CANVAS_BADGE_RIDGE = "#333333";
export const CANVAS_BADGE_INK = "#E0E0E0";

/**
 * The crop overlay's scrim: the part of a bitmap that falls OUTSIDE the frame it
 * is being cropped into.
 *
 * Black rather than a semantic surface, because it is painted over whatever the
 * document already has there — artwork, another bitmap, the canvas background —
 * and the only thing it may promise is "this is still your image, just not in
 * the frame". A tinted or lightened scrim says something about the artwork in
 * those pixels, which is exactly what it must not do. Alpha is composed at the
 * call site with {@link withAlpha}, like every other translucent canvas paint.
 *
 * Note what it does NOT do: it does not dim the bitmap into invisibility. The
 * tile has already clipped the bitmap away out there, so the overlay paints the
 * picture a second time under this scrim — the scrim is a veil over the image,
 * not a substitute for it.
 */
export const CANVAS_CROP_DIM = "#000000";
/**
 * The dark the paper plies are mixed toward. Black because depth at a break is
 * the absence of light, not a tint: the same value has to work over a
 * photograph, a cream page and a dark card.
 */
export const CANVAS_EDGE_SHADOW = "#000000";

/** The paper a break exposes when the layer declares no solid fill to borrow. */
export const CANVAS_EDGE_PAPER = "#EDE7DA";

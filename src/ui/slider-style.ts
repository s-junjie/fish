/**
 * The one handle every slider and rail carries: an 11px SQUARE `ink` chip,
 * centred on its value.
 *
 * Shared because the two were drawn separately — the colour panel's rails wore a
 * 14px round ring of their own — and two handles for one gesture makes a hue look
 * like a different kind of control from an opacity. The square is what makes it
 * an instrument (DESIGN.md §Components); the round ring was soft in the way a
 * consumer control is soft.
 *
 * The class carries the centring (`-mt`/`-ml`), so a caller only writes
 * `left: "<pct>%"` and does not have to know the chip's size.
 */
export const SLIDER_KNOB_CLASS =
  "absolute top-1/2 w-[11px] h-[11px] -mt-[5.5px] -ml-[5.5px] rounded-[1px] bg-ink shadow-[0_1px_3px_rgba(0,0,0,0.6)]";

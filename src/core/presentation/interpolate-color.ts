import { hexToRgb, parseColorAlpha } from "../geometry/color-utils";

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * One colour at `p`, through RGB and its own alpha.
 *
 * Both halves are normalised to the same six-digit form first: a stored colour
 * may be `#RRGGBBAA`, `rgba(...)` or one of the wide-gamut spellings the parser
 * reads, and interpolating the strings themselves would only ever pick one of
 * them at the midpoint.
 */
export function lerpColor(from: string, to: string, p: number): string {
  const a = parseColorAlpha(from);
  const b = parseColorAlpha(to);
  const ra = hexToRgb(a.hex6);
  const rb = hexToRgb(b.hex6);
  const alpha = round2(lerp(a.alphaPct / 100, b.alphaPct / 100, p));
  return `rgba(${Math.round(lerp(ra.r, rb.r, p))}, ${Math.round(lerp(ra.g, rb.g, p))}, ${Math.round(lerp(ra.b, rb.b, p))}, ${alpha})`;
}

/** The same colour at zero alpha — what a value only one slide has fades from. */
export function transparentColor(color: string): string {
  const { r, g, b } = hexToRgb(parseColorAlpha(color).hex6);
  return `rgba(${r}, ${g}, ${b}, 0)`;
}

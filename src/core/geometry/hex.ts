/**
 * `#rrggbb` writing, on its own so that the hex reader and the CSS colour-space
 * converter can both reach it without either importing the other.
 *
 * `color-utils.ts` re-exports it because every existing caller names it there —
 * the split is about dependency direction, not about where it is spelled.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const channel = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

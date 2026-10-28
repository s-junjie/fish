/**
 * A fallback face moves every glyph, so measuring before the webfonts settle
 * reports sub-pixel differences that belong to the font loader, not the layout.
 * The budget is bounded because a page that never settles must still answer.
 */
export async function fontsSettled(timeoutMs = 3000): Promise<boolean> {
  if (typeof document === "undefined" || !document.fonts) return false;
  const settled = document.fonts.ready.then(() => true);
  const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  try {
    return await Promise.race([settled, timedOut]);
  } catch {
    return false;
  }
}

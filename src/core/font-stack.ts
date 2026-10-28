/**
 * One family NAME in, one CSS font stack out.
 *
 * A document stores the family the author chose — `Inter`, not `Inter, system-ui,
 * sans-serif`. Storing the fallback beside it made a missing face undetectable:
 * `font-diagnostics` reads any generic keyword in the stack as the author saying
 * "substitution intended", so every family picked from the font menu looked
 * deliberate while painting as something else, and nothing in the file said which
 * family it actually wanted. The stack is assembled HERE instead, at paint and
 * measure time, from the bare name.
 *
 * Two properties make that safe:
 *  - `resolveStack` is IDEMPOTENT. A document authored before this split still
 *    stores a full stack (`"Inter, sans-serif"`); its stack contains a generic,
 *    so it comes back unchanged. The same holds for a caller that resolves and
 *    then hands the result to a second resolver.
 *  - Every reader shares this one function. A stack that differs by one entry
 *    measures differently from the way it paints, and the box then no longer
 *    fits its own text — the defect the canvas/layout split keeps re-creating.
 */

/**
 * The family a text gets when the author names none.
 *
 * `system-ui` rather than a named face: it resolves on every platform
 * (`SF Pro` on macOS, `Segoe UI` on Windows) with the full weight range and no
 * network, so a new layer can never open in a `missing` state. A named default
 * (`Inter`) was a claim the file could not keep on a machine without Inter.
 */
export const DEFAULT_FONT_FAMILY = "system-ui";

/**
 * What a family paints as when the machine cannot obtain it. Visible on purpose:
 * a silent metric-compatible swap hides a reflow, while a substitute the author
 * can see is a decision they can act on.
 */
export const SUBSTITUTE_STACK = "system-ui, sans-serif";

/**
 * Keywords that name no face and therefore always resolve. Both detection and
 * the font menu read this one set — a keyword missing from it is reported as a
 * `missing` face that is in fact drawing perfectly.
 */
const GENERIC_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont"
]);

export function isGenericFamily(name: string): boolean {
  return GENERIC_FAMILIES.has(name.trim().toLowerCase());
}

/**
 * A stack into its family names, unquoted and unescaped.
 *
 * Split on commas OUTSIDE quotes: `"Heavy, Impact"` is one family whose name has
 * a comma in it, and a naive `split(",")` turned it into two names that resolve
 * to nothing. `var(...)` entries are dropped — a custom property is not a face
 * this engine can measure or report on.
 */
export function splitFontStack(stack: string | undefined | null): string[] {
  if (!stack) return [];
  const parts: string[] = [];
  let buffer = "";
  let quote: string | null = null;

  for (let i = 0; i < stack.length; i++) {
    const ch = stack[i];
    if (quote) {
      if (ch === "\\" && i + 1 < stack.length) {
        buffer += stack[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      else buffer += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      parts.push(buffer);
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  parts.push(buffer);

  return parts.map((name) => name.trim()).filter((name) => name.length > 0 && !name.startsWith("var("));
}

/**
 * The family a stack actually asks for: its first entry that names a face.
 *
 * A generic-only stack (`system-ui`) names no face and returns `""` — it resolves
 * everywhere, so there is nothing to report on.
 */
export function firstNamedFamily(stack: string | undefined | null): string {
  for (const name of splitFontStack(stack)) {
    if (!isGenericFamily(name)) return name;
  }
  return "";
}

/**
 * A family name as CSS spells it: bare when it is a safe identifier, quoted
 * otherwise. Emitting `Heavy "Impact" Cut` unquoted parses as three families.
 */
export function cssFamilyName(name: string): string {
  const trimmed = name.trim();
  return /^-?[A-Za-z_][\w\- ]*$/.test(trimmed)
    ? trimmed
    : `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Whether the stack says for itself what to paint when its first family is
 * absent.
 *
 * A pre-split document (`"Helvetica Neue, Arial, sans-serif"`) declared its
 * substitution when it was written, and a substitute the author chose by hand is
 * the design — so nothing reports it, neither here nor in `font-diagnostics`.
 * One question, one answer: this rule is why BOTH detectors draw the line in the
 * same place. The reason the menu stopped appending a fallback (§`resolveStack`)
 * is that a fallback it wrote made every family the author had actually picked
 * undetectable.
 */
export function declaresFallback(stack: string | undefined | null): boolean {
  return splitFontStack(stack).some(isGenericFamily);
}

/**
 * The stack to paint and measure with.
 *
 * A stack that already names a generic keeps what it said: that is how a
 * pre-split document (`"Helvetica Neue, Arial, sans-serif"`, `"Menlo, monospace"`)
 * round-trips without gaining a second fallback, and it is what makes a second
 * application a no-op.
 */
export function resolveStack(fontFamily: string | undefined | null): string {
  const names = splitFontStack(fontFamily);
  if (names.length === 0) return SUBSTITUTE_STACK;
  if (names.some(isGenericFamily)) return names.map(cssFamilyName).join(", ");
  return `${names.map(cssFamilyName).join(", ")}, ${SUBSTITUTE_STACK}`;
}

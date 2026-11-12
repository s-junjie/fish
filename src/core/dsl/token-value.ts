/**
 * A token's value for the mode in scope — the one rule, for both tables.
 *
 * `doc.tokens[]` holds one base value plus a `modes` entry per mode, and two
 * readers need to answer "what is this token worth RIGHT NOW": the editor's sync
 * pass (`syncDualStorage`) and, since `$token` shorthands exist, the reader that
 * turns an author's reference into a stored value at normalize time. They must
 * answer the same, or a document renders one colour on load and another the
 * moment something re-syncs it.
 *
 * So the arithmetic lives here, in the DSL's vocabulary and with no editor in
 * sight. `interactions/style-sync` and `interactions/mode-ops` call these; they
 * used to own the copies.
 */

import type { ColorToken, NumberToken } from "./types";

/** The default mode id if none is specified on the document. */
export const DEFAULT_THEME = "default";

/** `modes[theme] ?? value` — a colour token's other half for the mode in scope. */
export function colorTokenValue(token: ColorToken, theme?: string): string {
  if (theme && token.modes && typeof token.modes[theme] === "string") return token.modes[theme];
  return token.value;
}

/** `modes[mode] ?? value` — a number token's other half for the mode in scope. */
export function numberTokenValue(token: NumberToken, mode?: string): number {
  if (mode && token.modes && typeof token.modes[mode] === "number") return token.modes[mode];
  return token.value;
}

/** The parts of a document that decide which mode a token resolves in. */
interface ModeSource {
  activeTheme?: unknown;
  activeNumberMode?: unknown;
  modes?: unknown;
  numberModes?: unknown;
}

/**
 * The first declared mode id, or nothing.
 *
 * Malformed entries are skipped rather than read: a mode whose `id` is not a
 * string cannot key a token's `modes` table anyway, and answering with it would
 * put a number where every caller expects a table key.
 */
function firstModeId(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/**
 * The colour mode in scope. Falls back to the first declared mode, then to
 * `DEFAULT_THEME` — a token may file a value under "default" in a document that
 * declares no mode list at all.
 */
export function themeOf(doc: ModeSource): string {
  if (typeof doc.activeTheme === "string" && doc.activeTheme) return doc.activeTheme;
  return firstModeId(doc.modes) ?? DEFAULT_THEME;
}

/**
 * The NUMBER mode in scope.
 *
 * Never the colour mode: brightness and density are independent, and a colour
 * switch that moved every radius is the defect the split exists to remove. The
 * element-level override is the one place the two are allowed to meet, and that
 * rule lives at the call site (`syncDualStorage`), not here.
 */
export function numberModeOf(doc: ModeSource): string {
  if (typeof doc.activeNumberMode === "string" && doc.activeNumberMode) return doc.activeNumberMode;
  return firstModeId(doc.numberModes) ?? DEFAULT_THEME;
}

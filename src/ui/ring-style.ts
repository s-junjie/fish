/**
 * The 1px dark ring that keeps a small mark legible on any background.
 *
 * It is not a shadow and must not become a depth tier: there is no blur and no
 * offset, only a dark outline that stops a 2px amber bar or a 12px dot from
 * dissolving into whatever it overlaps. DESIGN.md's three tiers
 * (`shadow-panel` / `-popover` / `-modal`) are all blurred elevations and would
 * be the wrong tool.
 *
 * It lives here because five files drew it by hand with three different alphas,
 * and an arbitrary `shadow-[…]` is exactly what `ui-conventions.test.ts` bans —
 * one definition, exempt by name, is the honest way to keep it.
 */
export const DARK_RING_CLASS = "shadow-[0_0_0_1px_rgba(0,0,0,0.45)]";

/** The stronger version, for a mark that sits on the busiest surface there is. */
export const DARK_RING_STRONG_CLASS = "shadow-[0_0_0_1px_rgba(0,0,0,0.8)]";

import type { Paint } from "../core/dsl/types";
import { t } from "../i18n";

/**
 * The vocabulary of paint kinds and of the switcher's tabs, in one place. The
 * colour panel, the selection-colours strip, the styles editor and the paint-row
 * previews all name the same kinds, and deriving the name where it was needed
 * made them drift: an angular fill read "Radial" in the styles editor and its
 * raw DSL string (`angular-gradient`) in a fill row.
 */

export type GradientKind = Extract<Paint["type"], `${string}-gradient`>;
/** `Paint["type"]` is the only list of kinds, so this cannot drift from the DSL. */
export type PaintKind = Paint["type"];

/** Sub-choice order — the order the colour panel and the tab labels walk them in. */
export const GRADIENT_KINDS: GradientKind[] = [
  "linear-gradient",
  "radial-gradient",
  "angular-gradient",
  "diamond-gradient"
];

export const isGradientKind = (kind: PaintKind): kind is GradientKind =>
  (GRADIENT_KINDS as PaintKind[]).includes(kind);

/**
 * The switcher's tabs. The four gradient dialects share ONE tab and are chosen a
 * level down: as siblings they were four near-identical names crowding out the
 * two things a paint actually differs in, and the tab was never the question —
 * which gradient is.
 */
export type PaintTab = "solid" | "gradient" | "image" | "pattern";

export const ALL_PAINT_TABS: PaintTab[] = ["solid", "gradient", "image", "pattern"];

/** Every tab that carries `from`/`to` (or `stops`) and therefore has a colour. */
export const COLOR_TABS: PaintTab[] = ["solid", "gradient"];

/**
 * What an outline can paint. No image: the canvas builds a `grad_stroke_*` and a
 * `pat_stroke_*` def for a stroke and nothing that could carry a bitmap, so the
 * tab offered a fill that renders as nothing — and its panel opened on "Missing
 * image" because a stroke panel has no assets to resolve one against.
 */
export const STROKE_PAINT_TABS: PaintTab[] = ["solid", "gradient", "pattern"];

export const tabOf = (kind: PaintKind): PaintTab => (isGradientKind(kind) ? "gradient" : kind);

const TAB_LABEL_KEY: Record<PaintTab, string> = {
  solid: "paint.solid",
  gradient: "paint.gradient",
  image: "paint.image",
  pattern: "paint.pattern"
};

const GRADIENT_LABEL_KEY: Record<GradientKind, string> = {
  "linear-gradient": "paint.linear",
  "radial-gradient": "paint.radial",
  "angular-gradient": "paint.angular",
  "diamond-gradient": "paint.diamond"
};

/** The long form, for a surface with room to spell it out (a style's subtitle). */
const GRADIENT_LONG_LABEL_KEY: Record<GradientKind, string> = {
  "linear-gradient": "paint.linearGradient",
  "radial-gradient": "paint.radialGradient",
  "angular-gradient": "paint.angularGradient",
  "diamond-gradient": "paint.diamondGradient"
};

export const tabLabel = (tab: PaintTab) => t(TAB_LABEL_KEY[tab]);

export const gradientKindLabel = (kind: GradientKind) => t(GRADIENT_LABEL_KEY[kind]);

export const gradientKindLongLabel = (kind: GradientKind) => t(GRADIENT_LONG_LABEL_KEY[kind]);

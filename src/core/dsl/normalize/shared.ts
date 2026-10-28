import type { DesignDocument, DesignElement, ElementType, SizeMode, TextStyle } from "../types";
import { ELEMENT_TYPES as ELEMENT_TYPE_VALUES } from "../schema-enums";

export const ELEMENT_TYPES = ELEMENT_TYPE_VALUES;
export type { ElementType };

export const FONT_WEIGHT_WORDS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  "extra-light": 200,
  light: 300,
  book: 400,
  regular: 400,
  normal: 400,
  medium: 500,
  semibold: 600,
  "semi-bold": 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  "extra-bold": 800,
  black: 900,
  heavy: 900
};

export const ALIGN_ALIASES: Record<string, TextStyle["align"]> = {
  left: "left",
  start: "left",
  center: "center",
  centre: "center",
  middle: "center",
  right: "right",
  end: "right",
  // Not a synonym for `left`. It IS the CSS `text-align: justify`, and mapping it
  // there is what made an author's request for flush-to-both-edges silently
  // render as a ragged right — with no repair, since "left" is a legal value.
  justify: "justify"
};

export const VERTICAL_ALIGN_ALIASES: Record<string, TextStyle["verticalAlign"]> = {
  top: "top",
  start: "top",
  middle: "middle",
  center: "middle",
  centre: "middle",
  bottom: "bottom",
  end: "bottom"
};

export const FIT_ALIASES: Record<string, "cover" | "contain" | "fill" | "crop"> = {
  cover: "cover",
  contain: "contain",
  fill: "fill",
  crop: "crop",
  "scale-down": "contain",
  "scale-down-to-fit": "contain",
  none: "fill",
  stretch: "fill",
  "fill-box": "fill"
};

/**
 * CSS-ish spellings the model reaches for, mapped onto the four canonical
 * sizing modes. ONE table: the `width`/`height` axis reader (`text-sizing.ts`)
 * and the compact sizing shorthand (`shorthand.ts`) both resolve through it —
 * two copies drifted the moment one learned a spelling the other did not.
 */
export const SIZE_MODE_ALIASES: Record<string, SizeMode> = {
  fixed: "fixed",
  manual: "fixed",
  none: "fixed",
  "fit-content": "fit-content",
  fitcontent: "fit-content",
  content: "fit-content",
  fit: "fit-content",
  hug: "fit-content",
  auto: "fit-content",
  "max-content": "max-content",
  maxcontent: "max-content",
  nowrap: "max-content",
  "no-wrap": "max-content",
  "auto-width": "max-content",
  fill: "fill",
  stretch: "fill",
  grow: "fill"
};

export type RepairKind =
  | "document"
  | "canvas"
  | "element"
  | "type"
  | "effect"
  | "paint"
  | "stroke"
  | "text"
  | "image"
  | "layout"
  | "sizing"
  | "metadata"
  | "dropped-property";

export interface NormalizationRepair {
  kind: RepairKind;
  /** JSON-pointer-ish path, e.g. `/elements/2/children/0/role`. */
  path: string;
  message: string;
  /**
   * `"info"` when nothing the author wrote was discarded: the engine renamed a
   * key it understood, relocated a value it kept, or supplied a default for
   * something left unsaid. Absent means the author's input was dropped, ignored
   * or reinterpreted, which is what `fish check` must fail on — a document that
   * merely omits `canvas` is not a document that dropped anything.
   */
  severity?: "info";
}

export interface NormalizeContext {
  /** Requested canvas size; when present it wins over whatever the model said. */
  canvas?: { width: number; height: number };
  preserveUnknown?: boolean;
}

/** A master's authored box, before normalisation turns a missing axis into 0. */
export interface RawComponentBox {
  width?: unknown;
  height?: unknown;
}

export type RawComponentBoxes = ReadonlyMap<string, RawComponentBox>;

export interface NormalizeResult {
  document: DesignDocument;
  repairs: NormalizationRepair[];
}

// ---------------------------------------------------------------------------
// small value helpers
// ---------------------------------------------------------------------------

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const asNumber = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    // Tolerate "24", "24px", "1.2rem"-style suffixes the model likes to add.
    const match = trimmed.match(/^-?\d*\.?\d+/);
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};

/**
 * The unit a length-like value carries, or `""` for a bare number.
 * `undefined` when the value is not length-like at all.
 *
 * `asNumber` is deliberately unit-blind — it strips any suffix — which is right
 * for the many fields that only ever hold px, but wrong for the ones a CSS author
 * reaches for with `%`, `rem` or `em`: `"90%"` silently became `90`. This is how a
 * caller that must not do that asks what the author actually wrote, so it can
 * report instead of guessing.
 */
export const lengthUnit = (v: unknown): string | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? "" : undefined;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (/^[+-]?\d*\.?\d+$/.test(trimmed)) return "";
  const match = trimmed.match(/^[+-]?\d*\.?\d+\s*([a-z%]+)$/i);
  return match ? match[1].toLowerCase() : undefined;
};

/** A px-or-bare length. Any other unit (%, em, rem, …) is `undefined` so the caller can report it. */
export const pxLength = (v: unknown): number | undefined => {
  const unit = lengthUnit(v);
  if (unit === "" || unit === "px") return asNumber(v);
  return undefined;
};

export const asBoolean = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;

/**
 * The clip flag, written either as CSS's `overflow` or as the DSL's
 * `clipContent` / Figma's `clipsContent`.
 *
 * Both spellings are first-class now, so neither is reported: `overflow` is what
 * this dialect WRITES (see `document-json`), and a document that round-trips
 * through the workbench must come back with an empty repair list. Reporting a
 * spelling the writer itself chose would fill the repair panel with one entry
 * per frame — noise that hides the repairs that matter.
 *
 * What is still reported is a genuine disagreement: both keys present with
 * different values. `overflow` accepts anything CSS does and maps what the
 * engine can express; `auto` / `scroll` clip in a way a canvas cannot, so they
 * are named rather than silently treated as `hidden`.
 */
export function normalizeClipContent(
  el: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): boolean | undefined {
  const dsl = asBoolean(el.clipContent ?? el.clipsContent ?? el.clip);
  const css = readOverflow(el.overflow, path, repairs);
  if (dsl !== undefined && css !== undefined && dsl !== css) {
    repairs.push({
      kind: "element",
      path: `${path}/overflow`,
      message: `overflow ${JSON.stringify(el.overflow)} and clipContent ${dsl} disagree; kept clipContent`
    });
    return dsl;
  }
  return dsl ?? css;
}

function readOverflow(
  raw: unknown,
  path: string,
  repairs: NormalizationRepair[]
): boolean | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "hidden" || value === "clip" || value === "auto" || value === "scroll") {
    if (value === "auto" || value === "scroll") {
      repairs.push({
        kind: "element",
        path: `${path}/overflow`,
        severity: "info",
        message: `"overflow: ${value}" has no canvas equivalent; clipped like "hidden"`
      });
    }
    return true;
  }
  if (value === "visible") return false;
  repairs.push({
    kind: "element",
    path: `${path}/overflow`,
    message: `"overflow: ${value}" is not one of hidden | clip | auto | scroll | visible; ignored`
  });
  return undefined;
}

/**
 * The visibility flag, written either as CSS's `visibility` or as the DSL's
 * boolean `visible`. Same rule as `normalizeClipContent`: both spellings are
 * silent, and only a disagreement is reported.
 */
export function normalizeVisible(
  el: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): boolean | undefined {
  const dsl = asBoolean(el.visible);
  const raw = el.visibility;
  if (typeof raw !== "string" || !raw.trim()) return dsl;
  const value = canonicalKey(raw);
  const css = value === "visible" ? true : value === "hidden" || value === "collapse" ? false : undefined;
  if (css === undefined) {
    repairs.push({
      kind: "element",
      path: `${path}/visibility`,
      message: `visibility "${raw}" is not one of visible | hidden | collapse; ignored`
    });
    return dsl;
  }
  if (dsl !== undefined && dsl !== css) {
    repairs.push({
      kind: "element",
      path: `${path}/visibility`,
      message: `visibility "${raw}" and visible ${dsl} disagree; kept visible`
    });
    return dsl;
  }
  return dsl ?? css;
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * `Hero Image` / `hero_image` / `hero-image` / `heroImage` all collapse to
 * `hero-image`.
 *
 * This is the one canonicaliser for keys AND values, so teaching it camelCase
 * splits both: it is how `alignItems` reaches `align-items`
 * and how a value written `scaleDown` reaches `scale-down`. Widening it is a
 * contract change, not a free alias — every table keyed by its output
 * (`FIT_ALIASES`, `SIZE_MODE_ALIASES`, blend / effect / decoration tables,
 * `slide.ts`) re-canonicalises with it, and `tests/canonical-key.test.ts` holds
 * the value side.
 */
export const canonicalKey = (v: string) =>
  v
    .trim()
    // Insert the separator at a lower→upper boundary BEFORE lower-casing,
    // otherwise the boundary is gone. An acronym run (`oklch`, `RGB`) has no
    // such boundary and stays intact.
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

/** The other direction: `border-radius` → `borderRadius`, the DSL's own spelling. */
export const camelCase = (v: string): string =>
  canonicalKey(v).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());


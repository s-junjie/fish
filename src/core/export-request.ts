/**
 * `?report=1&element=<id>` — the headless reporting channel.
 *
 * It exists so an agent can ask the engine questions with nothing installed:
 * `chrome --headless --dump-dom` prints the DOM and is part of the operating
 * system, so a URL parameter is the entire interface. See
 * `ui/hooks/useHeadlessReport.ts` for what it does and does not do.
 */

export interface ReportRequest {
  /** An element id to resolve. Absent means "report the document". */
  elementId?: string;
  /** Device pixel factor the caller intends to capture at. */
  scale: number;
  /**
   * Document point to place at the viewport's top-left. Purely a paint offset, so
   * a browser pointed at a window the size of the region captures exactly that
   * region — which is how an element crop works without the CLI ever having to
   * rasterize anything itself.
   */
  origin?: { x: number; y: number };
  /**
   * Measure the glyphs as well as the boxes. `check --audit` sets this: it is the
   * only reader of the page that grades the picture rather than the document.
   */
  audit?: boolean;
  /**
   * How far off, in CANVAS px, ink and boxes may sit before the audit reports it.
   *
   * One axis only: `audit` grades a distance, and a caller who widens it wants a
   * coarser grade, not a different rule. It is scaled to screen px by the
   * measured zoom before the rules see it, so 2 means 2 canvas px at any zoom.
   */
  auditTolerance?: number;
}

const ORIGIN_RE = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/;

/** A tolerance has to stay a tolerance: 0 would grade float noise, 100 would grade nothing. */
export const AUDIT_TOLERANCE_BOUNDS = { min: 0.25, max: 16 } as const;

export function auditToleranceOf(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(AUDIT_TOLERANCE_BOUNDS.max, Math.max(AUDIT_TOLERANCE_BOUNDS.min, n));
}

export function parseReportRequest(search: string): ReportRequest | null {
  const params = new URLSearchParams(search);
  if (params.get("report") !== "1" && !params.get("origin")) return null;
  const scale = Number(params.get("scale"));
  const request: ReportRequest = {
    scale: Number.isFinite(scale) && scale > 0 ? Math.min(scale, 8) : 1
  };
  const elementId = params.get("element");
  if (elementId) request.elementId = elementId;
  if (params.get("audit") === "1") request.audit = true;
  const tolerance = auditToleranceOf(params.get("auditTolerance"));
  if (tolerance !== undefined) request.auditTolerance = tolerance;
  const origin = ORIGIN_RE.exec(params.get("origin") ?? "");
  if (origin) request.origin = { x: +origin[1], y: +origin[2] };
  return request;
}

/**
 * The window a browser needs to capture a region, and the bitmap it will produce.
 *
 * Both are in CSS pixels for `--window-size`; the caller raises the resolution
 * with `--force-device-scale-factor`, so scaling here as well would scale the
 * region twice — the element ends up filling a quarter of a frame twice the size
 * it should occupy, which still looks like a plausible image.
 *
 * The bitmap is derived from the ROUNDED window, not from the original box. A box
 * of 112.59 at 2x is a 113px window and a 226px bitmap; computing the expectation
 * from the box instead promises 225 and reports a mismatch on every fractional
 * dimension, which trains the reader to ignore it.
 *
 * Emitted by the page rather than recomputed by the caller: the page is what knows
 * the element's box, and a shell that redoes the arithmetic has one more place for
 * the two to disagree, which is how a "verified" crop ends up showing the wrong
 * rectangle.
 */
export function screenshotPlan(
  width: number,
  height: number,
  scale: number
): { window: string; expected: string } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 8) : 1;
  return { window: `${w}x${h}`, expected: `${Math.round(w * s)}x${Math.round(h * s)}` };
}

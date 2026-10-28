import { parsePathData, serializePathData } from "../geometry/path-data";

/**
 * Iconify's wire format is a string of SVG markup, not path data: an icon body
 * is a `<g>` carrying the paint attributes with bare `<path>` / `<circle>` /
 * `<rect>` children inside it. FISH stores one `path` element, so a body has to
 * become a single `d` plus a statement of how the set paints it.
 *
 * The two sets this ships are single-mode by construction — Remix Icon bodies
 * are `fill="currentColor"`, Lucide's are `fill="none" stroke="currentColor"` —
 * so one element with one paint stack covers both. A body that mixes them, or
 * that uses a shape nobody has converted, returns null: an icon drawn slightly
 * wrong is worse than an icon the panel does not offer.
 */

/** Which stack a body paints into. Decided by whether anything carries a stroke. */
export type IconMode = "stroke" | "fill";

export type IconLineCap = "butt" | "round" | "square";
export type IconLineJoin = "miter" | "round" | "bevel";

export interface IconGeometry {
  /** Subpaths joined into one `d`, absolute, in the set's own viewBox units. */
  d: string;
  mode: IconMode;
  fillRule?: "nonzero" | "evenodd";
  strokeWidth?: number;
  cap?: IconLineCap;
  join?: IconLineJoin;
}

/** Paint attributes a `<g>` hands down to the shapes inside it. */
interface Paint {
  fill?: string;
  stroke?: string;
  fillRule?: string;
  strokeWidth?: string;
  strokeLinecap?: string;
  strokeLinejoin?: string;
}

/** Tags that carry no geometry of their own. */
const STRUCTURAL = new Set(["g", "svg", "defs", "title", "desc", "metadata", "style"]);

const SHAPE_TAGS = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);

const num = (v: string | undefined, fallback = 0): number => {
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Rounded harder than the 2dp the path serializer uses: these are 24-unit glyphs. */
const f = (v: number) => String(Math.round(v * 10000) / 10000);

const CAPS: readonly string[] = ["butt", "round", "square"];
const JOINS: readonly string[] = ["miter", "round", "bevel"];

interface OpenTag {
  tag: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
}

const ATTR_RE = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*"([^"]*)"/g;

function readAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(source))) attrs[m[1]] = m[2];
  return attrs;
}

/** One element's worth of geometry, in the coordinate system it was written in. */
function shapeToD(tag: string, a: Record<string, string>): string | null {
  switch (tag) {
    case "path":
      return a.d ?? null;
    case "line":
      return `M${f(num(a.x1))} ${f(num(a.y1))}L${f(num(a.x2))} ${f(num(a.y2))}`;
    case "circle":
    case "ellipse": {
      const rx = tag === "circle" ? num(a.r) : num(a.rx);
      const ry = tag === "circle" ? num(a.r) : num(a.ry);
      const cx = num(a.cx);
      const cy = num(a.cy);
      if (rx <= 0 || ry <= 0) return null;
      return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 1 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 1 ${f(cx - rx)} ${f(cy)}`;
    }
    case "rect": {
      const x = num(a.x);
      const y = num(a.y);
      const w = num(a.width);
      const h = num(a.height);
      if (w <= 0 || h <= 0) return null;
      const r = Math.min(num(a.rx ?? a.ry), w / 2, h / 2);
      if (r <= 0) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
      return (
        `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}` +
        `V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}` +
        `H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}` +
        `V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
      );
    }
    case "polyline":
    case "polygon": {
      // `points` is a flat number list — "x1 y1 x2 y2" — not pairs of "x,y".
      const coords = (a.points ?? "").trim().split(/[\s,]+/).map(Number);
      if (coords.length < 4 || coords.some((v) => !Number.isFinite(v))) return null;
      let d = `M${f(coords[0])} ${f(coords[1])}`;
      for (let k = 2; k + 1 < coords.length; k += 2) d += `L${f(coords[k])} ${f(coords[k + 1])}`;
      return tag === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

/**
 * Attribute name to field name. They are not the same string: SVG spells these
 * with a dash and the fields do not, so reading the paint by key alone silently
 * finds nothing and the icon falls back to the default stroke.
 */
const PAINT_ATTRS: ReadonlyArray<readonly [keyof Paint, string]> = [
  ["fill", "fill"],
  ["stroke", "stroke"],
  ["fillRule", "fill-rule"],
  ["strokeWidth", "stroke-width"],
  ["strokeLinecap", "stroke-linecap"],
  ["strokeLinejoin", "stroke-linejoin"]
];

/** Attributes a shape inherits from every open `<g>` plus its own. */
function effective(inherited: Paint[], own: Record<string, string>): Paint {
  const merged: Paint = { ...inherited[inherited.length - 1] };
  for (const [field, attr] of PAINT_ATTRS) {
    const v = own[attr];
    if (v !== undefined) merged[field] = v;
  }
  return merged;
}

/**
 * Body markup to one path element's worth of data.
 *
 * Relative commands are resolved by handing each shape to the engine's own
 * parser and serializing it back, which is also what a save does. That is the
 * point: icon geometry then round-trips through the same code as hand-drawn
 * geometry, and joining the results cannot shift a subpath.
 */
/** Paint values a body may use. Anything else names a paint server, a gradient
 * or a hard-coded colour, none of which survives being flattened into one
 * element with one paint stack — so the icon is refused rather than recoloured. */
const FILLABLE = new Set(["", "none", "currentColor"]);
const STROKEABLE = new Set(["", "none", "currentColor"]);

export function parseIconBody(body: string): IconGeometry | null {
  if (!body || !body.includes("<")) return null;

  const stack: Paint[] = [{}];
  const parts: string[] = [];
  const styles: Paint[] = [];
  let unsupported = false;
  let i = 0;

  while (i < body.length) {
    const lt = body.indexOf("<", i);
    if (lt < 0) break;
    const gt = body.indexOf(">", lt);
    if (gt < 0) break;
    const raw = body.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith("/")) {
      const close = raw.slice(1).trim().toLowerCase();
      if (STRUCTURAL.has(close) && stack.length > 1) stack.pop();
      continue;
    }
    if (raw.startsWith("!") || raw.startsWith("?")) continue;

    const selfClosing = raw.endsWith("/");
    const name = /^[a-zA-Z][a-zA-Z0-9]*/.exec(raw)?.[0] ?? "";
    if (!name) continue;
    const tag = name.toLowerCase();

    if (STRUCTURAL.has(tag)) {
      // A `<g>` is where these sets put the paint: Lucide's bodies are one
      // `<g fill="none" stroke="currentColor" stroke-width="2">` around bare
      // shapes, so its own attributes have to join what it inherits or every
      // icon in the set reads as unpainted.
      if (tag === "g" && !selfClosing) {
        stack.push(effective(stack, readAttrs(raw)));
      }
      continue;
    }
    if (!SHAPE_TAGS.has(tag)) {
      unsupported = true;
      continue;
    }

    const own = readAttrs(raw);
    const paint = effective(stack, own);
    const shape = shapeToD(tag, own);
    if (!shape) {
      unsupported = true;
      continue;
    }
    // Normalized per shape, never on the joined string: a body is a list of
    // independent subpaths and its `<path>` entries often open with a *relative*
    // moveto, which resolves from (0,0) on its own but from whatever the
    // previous shape ended at once two are concatenated. That is not a
    // rendering bug, it moves the geometry.
    const parsed = parsePathData(shape);
    const d = parsed ? serializePathData(parsed) : shape;
    if (!d) {
      unsupported = true;
      continue;
    }
    parts.push(d);
    styles.push(paint);

    // A paint this converter cannot reproduce marks the whole icon, which is
    // refused below rather than inserted in the wrong colour.
    if (!FILLABLE.has(paint.fill ?? "") || !STROKEABLE.has(paint.stroke ?? "")) unsupported = true;
  }

  if (unsupported || parts.length === 0) return null;

  const d = parts.join("");

  // A stroke anywhere in the body decides the mode for the whole icon, so a set
  // that paints its container with a stroke and its children with a fill still
  // arrives as the stroke-style icon it reads as.
  const stroked = styles.some((s) => !!s.stroke && s.stroke !== "none");
  const width = styles.map((s) => s.strokeWidth).find((v) => v !== undefined);
  const cap = styles.map((s) => s.strokeLinecap).find((v) => v !== undefined);
  const join = styles.map((s) => s.strokeLinejoin).find((v) => v !== undefined);
  const rule = styles.map((s) => s.fillRule).find((v) => v === "evenodd" || v === "nonzero");

  return {
    d,
    mode: stroked ? "stroke" : "fill",
    fillRule: rule,
    strokeWidth: stroked && width !== undefined ? num(width, 2) || 2 : undefined,
    cap: stroked && cap !== undefined && CAPS.includes(cap) ? (cap as IconLineCap) : undefined,
    join: stroked && join !== undefined && JOINS.includes(join) ? (join as IconLineJoin) : undefined
  };
}

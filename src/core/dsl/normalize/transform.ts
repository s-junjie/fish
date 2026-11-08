/**
 * The CSS transform surface, folded onto the engine's four geometry fields.
 *
 * The DSL stores a rotated box as `rotation` + optional `flipX` / `flipY`, and a
 * perspective tilt as `rotateX` / `rotateY`. CSS says the same things inside a
 * `transform` string (or the standalone `rotate` / `scale` properties), and an
 * author with CSS in mind writes them there. Without this, `rotate: "45deg"`
 * reached the unknown-key pass and the layer drew square.
 *
 * Only what has a field is absorbed: a uniform scale of 2 is a size, not a
 * transform, and there is nothing here to hold it — it is reported instead of
 * being dropped in silence. `translate` has no field at all.
 */

import { NormalizationRepair } from "./shared";

const ANGLE = /^(-?\d*\.?\d+)(deg|rad|grad|turn)?$/i;

/** An angle in any CSS unit, as degrees (the DSL's only angular unit). */
export function angleDegrees(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const match = ANGLE.exec(raw.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  switch ((match[2] ?? "deg").toLowerCase()) {
    case "deg":
      return n;
    case "rad":
      return (n * 180) / Math.PI;
    case "grad":
      return (n * 360) / 400;
    case "turn":
      return n * 360;
    default:
      return undefined;
  }
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** A length in px, from `600px` or a bare number. */
function lengthPx(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw > 0 ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const match = /^(\d*\.?\d+)(px)?$/i.exec(raw.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  return n > 0 ? n : undefined;
}

/** One `fn(args)` from a transform list, or nothing when the list is malformed. */
function* transformFunctions(raw: string): Generator<{ name: string; args: string[] }> {
  for (const match of raw.matchAll(/([a-z]+)\(([^)]*)\)/gi)) {
    yield {
      name: match[1].toLowerCase(),
      args: match[2].split(",").map((part) => part.trim()).filter((part) => part !== "")
    };
  }
}

/** What a transform said about the fields, and what it could not say. */
export interface TransformRead {
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  rotateX?: number;
  rotateY?: number;
  skewX?: number;
  skewY?: number;
  perspective?: number;
  /** Function names the DSL has no field for, e.g. `translate`, `matrix`. */
  unsupported: string[];
}

/**
 * A `scale()` magnitude: `-1` is the flip the DSL stores, `1` is nothing, and
 * anything else is a size the DSL cannot hold.
 */
function readScale(read: TransformRead, axis: "x" | "y" | "both", value: number, report: (what: string) => void): void {
  if (!Number.isFinite(value)) return;
  if (Math.abs(Math.abs(value) - 1) > 1e-6) {
    report(`scale(${value})`);
    // A negative scale still flips even when its magnitude is unsupported, so
    // the mirror the author asked for survives the part that was refused.
    if (value < 0) setFlip(read, axis);
    return;
  }
  if (value < 0) setFlip(read, axis);
}

function setFlip(read: TransformRead, axis: "x" | "y" | "both"): void {
  if (axis !== "y") read.flipX = true;
  if (axis !== "x") read.flipY = true;
}

/** Read a `transform` / `rotate` / `scale` authored on the element. */
export function readTransform(el: Record<string, unknown>, onUnsupported: (what: string) => void): TransformRead {
  const read: TransformRead = { unsupported: [] };

  const rotateProperty = angleDegrees(el.rotate);
  if (rotateProperty !== undefined) read.rotation = round(rotateProperty);

  const scaleProperty = el.scale;
  if (typeof scaleProperty === "number") {
    readScale(read, "both", scaleProperty, onUnsupported);
  } else if (typeof scaleProperty === "string" && scaleProperty.trim()) {
    const parts = scaleProperty.trim().split(/\s+/);
    if (parts.length === 1) {
      const n = Number(parts[0]);
      if (Number.isFinite(n)) readScale(read, "both", n, onUnsupported);
      else read.unsupported.push("scale");
    } else {
      const sx = Number(parts[0]);
      const sy = Number(parts[1]);
      if (Number.isFinite(sx)) readScale(read, "x", sx, onUnsupported);
      if (Number.isFinite(sy)) readScale(read, "y", sy, onUnsupported);
    }
  }

  const transform = el.transform;
  if (typeof transform !== "string" || !transform.trim() || transform.trim() === "none") return read;

  for (const { name, args } of transformFunctions(transform)) {
    switch (name) {
      case "rotate":
      case "rotatez": {
        const deg = angleDegrees(args[0]);
        if (deg !== undefined) read.rotation = round(deg);
        else read.unsupported.push(name);
        break;
      }
      case "rotatex": {
        const deg = angleDegrees(args[0]);
        if (deg !== undefined) read.rotateX = round(deg);
        else read.unsupported.push(name);
        break;
      }
      case "rotatey": {
        const deg = angleDegrees(args[0]);
        if (deg !== undefined) read.rotateY = round(deg);
        else read.unsupported.push(name);
        break;
      }
      case "scalex": {
        const n = Number(args[0]);
        if (Number.isFinite(n)) readScale(read, "x", n, onUnsupported);
        else read.unsupported.push(name);
        break;
      }
      case "scaley": {
        const n = Number(args[0]);
        if (Number.isFinite(n)) readScale(read, "y", n, onUnsupported);
        else read.unsupported.push(name);
        break;
      }
      case "scale": {
        const sx = Number(args[0] ?? 1);
        const sy = args.length > 1 ? Number(args[1]) : sx;
        if (Number.isFinite(sx) && Number.isFinite(sy) && sx === sy) readScale(read, "both", sx, onUnsupported);
        else {
          if (Number.isFinite(sx)) readScale(read, "x", sx, onUnsupported);
          if (Number.isFinite(sy)) readScale(read, "y", sy, onUnsupported);
        }
        break;
      }
      case "skew":
      case "skewx":
      case "skewy": {
        const ax = angleDegrees(args[0]);
        if (ax === undefined) {
          read.unsupported.push(name);
          break;
        }
        // `skew(a)` is `skewX(a)`, and only `skew` reads a second argument.
        if (name !== "skewy") read.skewX = round(ax);
        if (name !== "skewx") {
          const ay = name === "skew" ? angleDegrees(args[1] ?? 0) : ax;
          if (ay === undefined) read.unsupported.push(name);
          else if (ay) read.skewY = round(ay);
        }
        break;
      }
      case "perspective": {
        const px = lengthPx(args[0]);
        if (px !== undefined) read.perspective = round(px);
        else read.unsupported.push(name);
        break;
      }
      default:
        // `translate`, `matrix` — no field, named rather than
        // dropped, so "my transform did nothing" has an answer.
        read.unsupported.push(name);
    }
  }
  return read;
}

/**
 * Fold a read transform onto the element, letting an explicitly written DSL
 * field win: `rotation` is a statement about the field, a `transform` is a
 * statement about CSS, and the one the author spelled in this dialect outranks
 * the one absorbed from the other.
 *
 * Absorbing is silent, because these are the spellings the writer itself emits
 * (`rotate`, `scale` for a flip, `transform` for the tilt). A repair here fired
 * on every rotated, mirrored or tilted layer of every file on every load, which
 * is one line of `check` output per element and hides the repairs that matter.
 */
export function absorbTransform(
  el: Record<string, unknown>,
  base: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): void {
  const unsupported: string[] = [];
  const read = readTransform(el, (what) => unsupported.push(what));

  if (read.rotation !== undefined && el.rotation === undefined) base.rotation = read.rotation;

  for (const [field, value] of [
    ["rotateX", read.rotateX],
    ["rotateY", read.rotateY],
    ["perspective", read.perspective],
    ["skewX", read.skewX],
    ["skewY", read.skewY]
  ] as const) {
    if (value === undefined || el[field] !== undefined) continue;
    base[field] = value;
  }

  for (const [field, value] of [
    ["flipX", read.flipX],
    ["flipY", read.flipY]
  ] as const) {
    // `flipX: false` is a statement ("do not mirror"), not an absence — a
    // transform must not turn it into one.
    if (!value || el[field] !== undefined) continue;
    base[field] = true;
  }

  const refused = [...new Set([...unsupported, ...read.unsupported])];
  if (refused.length > 0) {
    repairs.push({
      kind: "element",
      path: `${path}/transform`,
      message: `transform functions with no DSL field were skipped: ${refused.join(", ")}`
    });
  }
}

/** Past this the tangent runs away: 89 is the last angle that is still a box. */
const SKEW_LIMIT = 89;

/**
 * The skew pair, settled as a PAIR — run after `absorbTransform`, so a shear
 * written in the DSL and one absorbed from CSS meet the same limits.
 *
 * `tan` is unbounded at 90, so each axis is clamped to ±89. And
 * `det = 1 − tan(skewX)·tan(skewY)` is zero at 45/45: a singular transform
 * paints nothing and has no inverse, so the second axis is dropped instead —
 * a layer sheared to a line is not a layer.
 */
export function settleSkew(base: Record<string, unknown>, path: string, repairs: NormalizationRepair[]): void {
  for (const field of ["skewX", "skewY"] as const) {
    const value = base[field];
    if (typeof value !== "number" || Math.abs(value) <= SKEW_LIMIT) continue;
    base[field] = Math.sign(value) * SKEW_LIMIT;
    repairs.push({
      kind: "element",
      path: `${path}/${field}`,
      message: `${field} ${value} is past the vertical axis; clamped to ${base[field]}`
    });
  }

  const ax = typeof base.skewX === "number" ? base.skewX : 0;
  const ay = typeof base.skewY === "number" ? base.skewY : 0;
  if (!ax || !ay) return;
  const det = 1 - Math.tan((ax * Math.PI) / 180) * Math.tan((ay * Math.PI) / 180);
  if (Math.abs(det) > 1e-3) return;
  delete base.skewY;
  repairs.push({
    kind: "element",
    path: `${path}/skewY`,
    message: `skewX ${ax} with skewY ${ay} collapses the box to a line; skewY dropped`
  });
}

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
 * being dropped in silence. `translate` and `skew` have no field at all.
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

/** One `fn(args)` from a transform list, or nothing when the list is malformed. */
function* transformFunctions(raw: string): Generator<{ name: string; args: string[] }> {
  for (const match of raw.matchAll(/([a-z]+)\(([^)]*)\)/gi)) {
    yield {
      name: match[1].toLowerCase(),
      args: match[2].split(",").map((part) => part.trim()).filter((part) => part !== "")
    };
  }
}

/** What a transform said about the four fields, and what it could not say. */
export interface TransformRead {
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  rotateX?: number;
  rotateY?: number;
  /** Function names the DSL has no field for, e.g. `skew`, `translate`. */
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
      default:
        // `translate`, `skew`, `matrix`, `perspective` — no field, named rather
        // than dropped, so "my transform did nothing" has an answer.
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
 */
export function absorbTransform(
  el: Record<string, unknown>,
  base: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): void {
  const unsupported: string[] = [];
  const read = readTransform(el, (what) => unsupported.push(what));

  const applyRotation = (value: number | undefined) => {
    if (value === undefined || el.rotation !== undefined) return;
    base.rotation = value;
    repairs.push({
      kind: "element",
      path: `${path}/transform`,
      severity: "info",
      message: `${el.rotate !== undefined ? "rotate" : "transform"} absorbed as rotation ${value}`
    });
  };
  applyRotation(read.rotation);

  for (const [field, value] of [
    ["rotateX", read.rotateX],
    ["rotateY", read.rotateY]
  ] as const) {
    if (value === undefined || el[field] !== undefined) continue;
    base[field] = value;
    repairs.push({
      kind: "element",
      path: `${path}/transform`,
      severity: "info",
      message: `transform absorbed as ${field} ${value}`
    });
  }

  for (const [field, value] of [
    ["flipX", read.flipX],
    ["flipY", read.flipY]
  ] as const) {
    // `flipX: false` is a statement ("do not mirror"), not an absence — a
    // transform must not turn it into one.
    if (!value || el[field] !== undefined) continue;
    base[field] = true;
    repairs.push({
      kind: "element",
      path: `${path}/transform`,
      severity: "info",
      message: `negative scale absorbed as ${field}`
    });
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

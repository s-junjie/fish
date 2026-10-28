import * as polygonClippingNs from "polygon-clipping";
import { parsePathData, serializePathData, EditablePath, EditableSegment, Pt } from "./path-data";
import { splitSubpaths } from "./path-ops";
import { fitRingToEdges } from "./curve-fit";
import { DesignDocument, DesignElement, PathElement, StarElement, getActivePage, updateActivePageElements } from "../dsl/types";
import { starToPathData } from "./shape-path";
import { createId } from "../id";
import { topLayer } from "../dsl/paint-stack";
import { DEFAULT_ELEMENT_COLOR } from "../dsl/defaults";
import { elementPivot, elementTransformMatrix } from "./transforms";
import { isIdentityMatrix, transformPoint } from "./matrix";

interface PolygonClippingApi {
  union(geom: unknown, ...geoms: unknown[]): unknown;
  difference(geom: unknown, ...geoms: unknown[]): unknown;
  intersection(geom: unknown, ...geoms: unknown[]): unknown;
  xor(geom: unknown, ...geoms: unknown[]): unknown;
}

const pc: PolygonClippingApi =
  (polygonClippingNs as unknown as { default?: PolygonClippingApi }).default ??
  (polygonClippingNs as unknown as PolygonClippingApi);

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

type Ring = [number, number][];

const CURVE_SAMPLES = 20;
const CORNER_SAMPLES = 8;

export function rectRing(
  x: number,
  y: number,
  width: number,
  height: number,
  radii: [number, number, number, number] = [0, 0, 0, 0]
): Ring {
  const r = radii.map((v) => Math.max(0, Math.min(v, Math.min(width, height) / 2)));
  const pts: Ring = [];
  const arc = (cx: number, cy: number, from: number, to: number, radius: number) => {
    for (let i = 0; i <= CORNER_SAMPLES; i++) {
      const a = from + ((to - from) * i) / CORNER_SAMPLES;
      pts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
    }
  };
  const [tl, tr, br, bl] = r;
  arc(x + tl, y + tl, Math.PI, (3 * Math.PI) / 2, tl);
  arc(x + width - tr, y + tr, (3 * Math.PI) / 2, 2 * Math.PI, tr);
  arc(x + width - br, y + height - br, 0, Math.PI / 2, br);
  arc(x + bl, y + height - bl, Math.PI / 2, Math.PI, bl);
  return dedupeRing(pts);
}

export function ellipseRing(cx: number, cy: number, rx: number, ry: number): Ring {
  const pts: Ring = [];
  const steps = CURVE_SAMPLES * 4;
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return dedupeRing(pts);
}

export function polygonRing(
  x: number,
  y: number,
  width: number,
  height: number,
  sides: number
): Ring {
  const n = Math.min(24, Math.max(3, Math.round(sides) || 5));
  const rx = width / 2;
  const ry = height / 2;
  const pts: Ring = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    pts.push([x + rx + rx * Math.cos(angle), y + ry + ry * Math.sin(angle)]);
  }
  return dedupeRing(pts);
}

export function pathRing(d: string, offsetX = 0, offsetY = 0): Ring | null {
  const model = parsePathData(d);
  if (!model || model.segments.length === 0) return null;
  return pathModelRing(model, offsetX, offsetY);
}

export function pathModelRing(model: EditablePath, offsetX = 0, offsetY = 0): Ring {
  const pts: Ring = [];
  const at = (p: Pt): [number, number] => [p.x + offsetX, p.y + offsetY];
  const cur = model.anchors[0];
  if (!cur) return pts;
  pts.push(at(cur));
  for (const seg of model.segments) {
    const a = model.anchors[seg.a];
    const b = model.anchors[seg.b];
    if (!a || !b) continue;
    if (seg.kind === "line") {
      pts.push(at(b));
    } else if (seg.kind === "quad") {
      for (let i = 1; i <= CURVE_SAMPLES; i++) {
        const t = i / CURVE_SAMPLES;
        const u = 1 - t;
        pts.push(at({
          x: u * u * a.x + 2 * u * t * seg.c.x + t * t * b.x,
          y: u * u * a.y + 2 * u * t * seg.c.y + t * t * b.y
        }));
      }
    } else {
      for (let i = 1; i <= CURVE_SAMPLES; i++) {
        const t = i / CURVE_SAMPLES;
        const u = 1 - t;
        pts.push(at({
          x: u * u * u * a.x + 3 * u * u * t * seg.ca.x + 3 * u * t * t * seg.cb.x + t * t * t * b.x,
          y: u * u * u * a.y + 3 * u * u * t * seg.ca.y + 3 * u * t * t * seg.cb.y + t * t * t * b.y
        }));
      }
    }
  }
  return dedupeRing(pts);
}

function dedupeRing(pts: Ring): Ring {
  const out: Ring = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev[0] - p[0]) > 1e-6 || Math.abs(prev[1] - p[1]) > 1e-6) {
      out.push(p);
    }
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) <= 1e-6 && Math.abs(first[1] - last[1]) <= 1e-6) {
      out.pop();
    } else break;
  }
  return out;
}

export function booleanRings(op: BooleanOp, rings: Ring[]): Ring[] {
  return booleanPolygons(op, rings.map((r) => [r] as Ring[]));
}

/**
 * The same operation over inputs that may each be a compound shape.
 *
 * `polygon-clipping` takes MultiPolygons, so an element with a hole has to
 * arrive as several rings in ONE polygon — passing its rings as separate
 * operands would union the hole shut.
 */
export function booleanPolygons(op: BooleanOp, polygons: Ring[][]): Ring[] {
  const inputs = polygons.filter((p) => p.some((r) => r.length >= 3));
  if (inputs.length === 0) return [];
  let acc: Ring[][] = [inputs[0]];
  for (let i = 1; i < inputs.length; i++) {
    const clip: Ring[][] = [inputs[i]];
    const raw =
      op === "union"
        ? pc.union(acc, clip)
        : op === "subtract"
          ? pc.difference(acc, clip)
          : op === "intersect"
            ? pc.intersection(acc, clip)
            : pc.xor(acc, clip);
    acc = (raw ?? []) as Ring[][];
    if (acc.length === 0) return [];
  }
  const out: Ring[] = [];
  for (const poly of acc) out.push(...poly);
  return out;
}

export interface RingPathData {
  d: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Turns result rings back into path data.
 *
 * The rings are polylines — that is the only currency `polygon-clipping` deals
 * in — so each one is fitted back into cubics here. Emitting the vertices as
 * `L` commands would turn a circle into an 80-gon, which is the difference
 * between a boolean that looks right and one that visibly faceting.
 */
export function ringsToPathData(rings: Ring[]): RingPathData | null {
  const valid = rings.filter((r) => r.length >= 3);
  if (valid.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of valid) {
    for (const [px, py] of ring) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }

  // `d` lives in the element's OWN coordinate space, so the ring's world
  // coordinates have to come back off by the box origin. Emitting them as they
  // are doubles the offset: a shape drawn at (200, 200) lands at (400, 400), off
  // the viewport, and the boolean reads as having deleted everything.
  const local = (p: Pt): Pt => ({ x: p.x - minX, y: p.y - minY });

  const anchors: Array<Pt & { m?: true }> = [];
  const segments: EditableSegment[] = [];
  for (const ring of valid) {
    const fitted = fitRingToEdges(ring);
    if (!fitted) continue;
    const base = anchors.length;
    for (let i = 0; i < fitted.anchors.length; i++) {
      const p = local(fitted.anchors[i]);
      // Only a ring's FIRST anchor begins a subpath; the rest are ordinary points.
      anchors.push(i === 0 && base > 0 ? { x: p.x, y: p.y, m: true } : { x: p.x, y: p.y });
    }
    let a = base;
    for (const edge of fitted.edges) {
      const b = base + edge.toIdx;
      if (edge.kind === "line") {
        segments.push({ kind: "line", a, b });
      } else {
        segments.push({
          kind: "cubic",
          a,
          b,
          ca: edge.ca ? local(edge.ca) : local(fitted.anchors[b]),
          cb: edge.cb ? local(edge.cb) : local(fitted.anchors[b])
        });
      }
      a = b;
    }
  }
  if (anchors.length === 0) return null;

  return {
    d: serializePathData({ anchors, segments, closed: true }),
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

export function elementToRing(el: DesignElement): Ring | null {
  const rings = elementToRings(el);
  return rings.length > 0 ? rings[0] : null;
}

/**
 * One element's outlines as separate rings in WORLD space — the space the
 * renderer paints it in, because the result is written back as a path that
 * carries no transform of its own.
 *
 * `polygon-clipping` has no matrix, so an operand's `rotation` / `flipX` /
 * `flipY` has to reach the points. Left unapplied, a turned element was clipped
 * as its unturned box: a square minus its own 45° twin came back EMPTY, and a
 * turned operand's overlap was wrong everywhere it differed from its box.
 */
export function elementToRings(el: DesignElement): Ring[] {
  const rings = localRings(el);
  if (rings.length === 0) return rings;
  const pivot = elementPivot(el);
  const m = elementTransformMatrix(el, pivot.x, pivot.y);
  if (isIdentityMatrix(m)) return rings;
  return rings.map((ring) =>
    ring.map(([px, py]) => {
      const p = transformPoint(m, { x: px, y: py });
      return [p.x, p.y] as [number, number];
    })
  );
}

/**
 * The same outlines before the element's own transform: absolute canvas
 * coordinates with `rotation` still to be applied.
 *
 * A `path` may carry several subpaths, and each is its own ring: reading them
 * as one would draw a bridge across the hole.
 */
function localRings(el: DesignElement): Ring[] {
  if (el.type === "rect") {
    const radii = Array.isArray(el.borderRadius)
      ? el.borderRadius
      : ([el.borderRadius || 0, el.borderRadius || 0, el.borderRadius || 0, el.borderRadius || 0] as [number, number, number, number]);
    return [rectRing(el.x, el.y, el.width, el.height, radii)];
  }
  if (el.type === "ellipse") {
    return [ellipseRing(el.x + el.width / 2, el.y + el.height / 2, el.width / 2, el.height / 2)];
  }
  if (el.type === "polygon") {
    return [polygonRing(el.x, el.y, el.width, el.height, el.sides || 5)];
  }
  if (el.type === "star") {
    // Through `pathRing` rather than a hand-built vertex ring: a smoothed star's
    // corners are curves, and `pathModelRing` already samples those per segment,
    // so the boolean sees the outline the renderer draws instead of a pointed
    // approximation of it.
    const ring = pathRing(starToPathData(el), el.x, el.y);
    return ring ? [ring] : [];
  }
  if (el.type === "path") {
    const model = parsePathData(el.d || "");
    if (!model) return [];
    return splitSubpaths(model)
      .map((part) => pathModelRing(part, el.x, el.y))
      .filter((r) => r.length >= 3);
  }
  return [];
}

export function performBooleanOperation(
  doc: DesignDocument,
  selectedIds: Set<string>,
  op: BooleanOp
): { doc: DesignDocument; newElementId: string | null } {
  const activePage = getActivePage(doc);
  const elements = activePage.children;
  const selectedElements = elements.filter((el) => selectedIds.has(el.id));
  if (selectedElements.length < 2) return { doc, newElementId: null };

  const polygons: Ring[][] = [];
  for (const el of selectedElements) {
    const rings = elementToRings(el);
    if (rings.length > 0) polygons.push(rings);
  }

  if (polygons.length < 2) return { doc, newElementId: null };

  const resultRings = booleanPolygons(op, polygons);
  const pathData = ringsToPathData(resultRings);
  if (!pathData) return { doc, newElementId: null };

  const firstEl = selectedElements[0] as any;
  const newId = createId("bool_path");
  const compoundPath: PathElement = {
    id: newId,
    type: "path",
    name: `${op.charAt(0).toUpperCase() + op.slice(1)} Shape`,
    x: pathData.x,
    y: pathData.y,
    width: pathData.width,
    height: pathData.height,
    d: pathData.d,
    fills: firstEl.fills || [{ type: "solid", color: DEFAULT_ELEMENT_COLOR }],
    // Relying on winding would make every hole depend on which operand happened
    // to be first; even-odd reads a nested ring as a hole either way round.
    fillRule: "evenodd",
    ...(firstEl.strokes ? { strokes: firstEl.strokes } : {})
  };

  const newElements: DesignElement[] = [];
  let inserted = false;
  for (const el of elements) {
    if (selectedIds.has(el.id)) {
      if (!inserted) {
        newElements.push(compoundPath);
        inserted = true;
      }
    } else {
      newElements.push(el);
    }
  }

  return {
    doc: updateActivePageElements(doc, newElements),
    newElementId: newId
  };
}

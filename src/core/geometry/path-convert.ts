import {
  DesignElement,
  RectElement,
  EllipseElement,
  PolygonElement,
  StarElement,
  LineElement,
  ArrowElement,
  PathElement
} from "../dsl/types";
import { parseCornerRadii } from "./rounded-box";
import { ellipseToPathData, polygonToPathData, starToPathData } from "../compile";

const KAPPA = 0.5522847498307935;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function rectToVectorPath(el: RectElement): string {
  const w = el.width;
  const h = el.height;
  const radii = parseCornerRadii(el.borderRadius);
  let [tl, tr, br, bl] = radii;

  const topSum = tl + tr;
  if (topSum > w && topSum > 0) {
    const s = w / topSum;
    tl *= s;
    tr *= s;
  }
  const bottomSum = bl + br;
  if (bottomSum > w && bottomSum > 0) {
    const s = w / bottomSum;
    bl *= s;
    br *= s;
  }
  const leftSum = tl + bl;
  if (leftSum > h && leftSum > 0) {
    const s = h / leftSum;
    tl *= s;
    bl *= s;
  }
  const rightSum = tr + br;
  if (rightSum > h && rightSum > 0) {
    const s = h / rightSum;
    tr *= s;
    br *= s;
  }

  if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
    return `M 0 0 L ${r2(w)} 0 L ${r2(w)} ${r2(h)} L 0 ${r2(h)} Z`;
  }

  const parts: string[] = [];
  parts.push(`M ${r2(tl)} 0`);
  if (w - tr > tl) parts.push(`L ${r2(w - tr)} 0`);
  if (tr > 0) {
    const k = tr * KAPPA;
    parts.push(`C ${r2(w - tr + k)} 0 ${r2(w)} ${r2(tr - k)} ${r2(w)} ${r2(tr)}`);
  }
  if (h - br > tr) parts.push(`L ${r2(w)} ${r2(h - br)}`);
  if (br > 0) {
    const k = br * KAPPA;
    parts.push(`C ${r2(w)} ${r2(h - br + k)} ${r2(w - br + k)} ${r2(h)} ${r2(w - br)} ${r2(h)}`);
  }
  if (w - br > bl) parts.push(`L ${r2(bl)} ${r2(h)}`);
  if (bl > 0) {
    const k = bl * KAPPA;
    parts.push(`C ${r2(bl - k)} ${r2(h)} 0 ${r2(h - bl + k)} 0 ${r2(h - bl)}`);
  }
  if (h - bl > tl) parts.push(`L 0 ${r2(tl)}`);
  if (tl > 0) {
    const k = tl * KAPPA;
    parts.push(`C 0 ${r2(tl - k)} ${r2(tl - k)} 0 ${r2(tl)} 0`);
  }
  parts.push("Z");
  return parts.join(" ");
}

// Shares the renderer's implementation so a converted element keeps its sweep
// and inner radius; `parsePathData` turns the arcs back into cubics for editing.
export function ellipseToVectorPath(el: EllipseElement): string {
  return ellipseToPathData(el);
}

export function polygonToVectorPath(el: PolygonElement): string {
  return polygonToPathData(el);
}

export function starToVectorPath(el: StarElement): string {
  return starToPathData(el);
}

export function lineToVectorPath(el: LineElement | ArrowElement): { d: string; x: number; y: number; width: number; height: number } {
  const x2 = el.x + el.dx;
  const y2 = el.y + el.dy;
  const minX = Math.min(el.x, x2);
  const minY = Math.min(el.y, y2);
  const width = Math.max(1, Math.abs(el.dx));
  const height = Math.max(1, Math.abs(el.dy));
  const startX = r2(el.x - minX);
  const startY = r2(el.y - minY);
  const endX = r2(x2 - minX);
  const endY = r2(y2 - minY);
  return {
    d: `M ${startX} ${startY} L ${endX} ${endY}`,
    x: minX,
    y: minY,
    width,
    height
  };
}

export function isConvertibleToPath(el: DesignElement): boolean {
  return (
    el.type === "rect" ||
    el.type === "ellipse" ||
    el.type === "polygon" ||
    el.type === "star" ||
    el.type === "line" ||
    el.type === "arrow"
  );
}

export function convertShapeToPathElement(el: DesignElement): PathElement | null {
  if (el.type === "path") return el as PathElement;
  if (!isConvertibleToPath(el)) return null;

  let d = "";
  let x = el.x;
  let y = el.y;
  let width = el.width;
  let height = el.height;

  if (el.type === "rect") {
    d = rectToVectorPath(el as RectElement);
  } else if (el.type === "ellipse") {
    d = ellipseToVectorPath(el as EllipseElement);
  } else if (el.type === "polygon") {
    d = polygonToVectorPath(el as PolygonElement);
  } else if (el.type === "star") {
    d = starToVectorPath(el as StarElement);
  } else if (el.type === "line" || el.type === "arrow") {
    const res = lineToVectorPath(el as LineElement | ArrowElement);
    d = res.d;
    x = res.x;
    y = res.y;
    width = res.width;
    height = res.height;
  }

  if (!d) return null;

  return {
    id: el.id,
    type: "path",
    name: el.name ? `${el.name}` : "Vector",
    x,
    y,
    width,
    height,
    rotation: el.rotation,
    opacity: el.opacity,
    locked: el.locked,
    visible: el.visible,
    blendMode: el.blendMode,
    fillEnabled: el.fillEnabled,
    fills: el.fills,
    strokes: el.strokes,
    isMask: el.isMask,
    effects: el.effects,
    adjust: el.adjust,
    d
  };
}

import { asNumber } from "../shared";
import { normalizeFillStack } from "../paint";
import { normalizeStrokes } from "../stroke";
import type { ElementBranch } from "./shared";

export const normalizeEllipse: ElementBranch = ({ el, base, path, repairs }) => {
  const fills = normalizeFillStack(el, path, repairs);
  if (fills !== undefined) {
    base.fills = fills;
  } else {
    base.fills = [{ type: "solid", color: "transparent" }];
    repairs.push({
      kind: "paint",
      path: `${path}/fills`,
      severity: "info",
      message: 'ellipse had no fill; defaulted to "transparent"'
    });
  }

  const strokes = normalizeStrokes(el, path, repairs);
  if (strokes) base.strokes = strokes;

  // Optional: only written when supplied, so a document that never set a
  // sweep survives a normalize round-trip byte-identical.
  const sweep = asNumber(el.sweep);
  if (sweep !== undefined) base.sweep = Math.min(360, Math.max(0, sweep));
  const innerRadius = asNumber(el.innerRadius);
  if (innerRadius !== undefined) base.innerRadius = Math.min(0.99, Math.max(0, innerRadius));
  const startAngle = asNumber(el.startAngle);
  if (startAngle !== undefined) base.startAngle = Math.min(360, Math.max(0, startAngle));
  const gap = asNumber(el.gap);
  if (gap !== undefined) base.gap = Math.min(180, Math.max(0, gap));
};

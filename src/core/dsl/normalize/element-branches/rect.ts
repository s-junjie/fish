import { normalizeFillStack } from "../paint";
import { cornerRadiusInput, normalizeCornerRadius, normalizeStrokes } from "../stroke";
import { normalizeCornerControls, type ElementBranch } from "./shared";

export const normalizeRect: ElementBranch = ({ el, base, path, repairs, box }) => {
  // `fills` is required by the schema. An explicit empty stack (fills: []) or
  // disabled fill means the author intentionally declared no fill (e.g. pure wireframe).
  // If omitted entirely, backfill transparent and report it so authors are guided.
  const fills = normalizeFillStack(el, path, repairs);
  if (fills !== undefined) {
    base.fills = fills;
  } else {
    base.fills = [{ type: "solid", color: "transparent" }];
    repairs.push({
      kind: "paint",
      path: `${path}/fills`,
      severity: "info",
      message: 'rect had no fill; defaulted to "transparent"'
    });
  }

  const strokes = normalizeStrokes(el, path, repairs);
  if (strokes) base.strokes = strokes;

  const radius = normalizeCornerRadius(cornerRadiusInput(el), path, repairs, box);
  if (radius !== undefined) base.borderRadius = radius;
  normalizeCornerControls(el, base, true);
};

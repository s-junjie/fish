/**
 * A colour axis written past the range the panel can reach.
 *
 * `normalizeColorFilter` clamps every axis the RENDERER clamps, so this is not
 * that check: what is left is the three multipliers with no upper bound
 * (`brightness`, `contrast`, `saturation`), where an author reading "percentage"
 * writes `6` and gets six times the effect. The value is legal — CSS `filter`
 * says so — which is exactly why it needs saying: the document holds something
 * the slider, whose track stops at 2, can never produce again.
 *
 * A warning, not an error: the picture is what the author asked for. `--strict`
 * is where "the panel must be able to edit everything in this file" belongs.
 */

import type { CompileDiagnostic } from "./compile";
import type { DesignDocument } from "./dsl/types";
import { ADJUST_AXES } from "./dsl/color-filter";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function adjustDiagnostics(doc: DesignDocument): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  const seen = new WeakSet<object>();

  const grade = (filter: Record<string, unknown>, path: string, elementId?: string) => {
    for (const axis of ADJUST_AXES) {
      // Read modulo 360, so an out-of-track turn paints the number the panel
      // would have stored anyway; warning about it would be noise.
      if (axis.key === "hueRotate") continue;
      const value = filter[axis.key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (value >= axis.atMin && value <= axis.atMax) continue;
      const bound = value > axis.atMax ? axis.atMax : axis.atMin;
      out.push({
        level: "warning",
        message: `${path}/${axis.key} is ${value}, past the ${axis.atMin}..${axis.atMax} the slider reaches — it renders, but the panel cannot get back to it`,
        ...(elementId ? { elementId } : {}),
        hint: `${axis.key}: ${bound}`
      });
    }
  };

  const visit = (value: unknown, path: string, elementId?: string) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}/${i}`, elementId));
      return;
    }
    const node = value as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id : elementId;
    if (isPlainObject(node.adjust)) grade(node.adjust, `${path}/adjust`, id);
    for (const [key, child] of Object.entries(node)) visit(child, `${path}/${key}`, id);
  };

  visit(doc, "");
  return out;
}

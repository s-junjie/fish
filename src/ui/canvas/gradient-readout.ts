import type { Paint } from "../../core/dsl/types";
import { t } from "../../i18n";
import type { GradientHandle } from "../hooks/canvas-gestures/gradient-gesture";

const pct = (fraction: number) => Math.round(fraction * 100);
const deg = (value: number) => Math.round(value);

/**
 * What the drag badge says, per grip.
 *
 * Read from the LIVE paint, never from the gesture's own accumulator: the two
 * would agree anyway, and deriving it here means the number on screen is the
 * number the document holds — a readout that can disagree with the artwork is
 * worse than no readout.
 *
 * `null` for a grip with nothing honest to report (never a placeholder).
 */
export function gradientReadout(paint: Paint, handle: GradientHandle): string | null {
  if (paint.type === "linear-gradient") {
    if (handle === "axis") {
      const start = paint.start;
      return start ? t("paint.hud.point", { x: pct(start.x), y: pct(start.y) }) : null;
    }
    const angle = typeof paint.angle === "number" ? paint.angle : 90;
    return t("paint.hud.angle", { value: deg(angle) });
  }
  if (paint.type === "radial-gradient" || paint.type === "diamond-gradient") {
    const center = paint.center ?? { x: 0.5, y: 0.5 };
    if (handle === "center") {
      return t("paint.hud.center", { x: pct(center.x), y: pct(center.y) });
    }
    if (handle === "rimX") {
      const rx = paint.rx ?? paint.radius ?? 0.75;
      return t("paint.hud.axisX", { angle: deg(paint.angle ?? 0), value: pct(rx) });
    }
    if (handle === "rimY") {
      const ry = paint.ry ?? paint.radius ?? 0.75;
      return t("paint.hud.axisY", { value: pct(ry) });
    }
    return null;
  }
  if (paint.type === "angular-gradient") {
    const center = paint.center ?? { x: 0.5, y: 0.5 };
    if (handle === "center") {
      return t("paint.hud.center", { x: pct(center.x), y: pct(center.y) });
    }
    if (handle === "sweep") {
      return t("paint.hud.angle", { value: deg(paint.angle ?? 0) });
    }
  }
  return null;
}

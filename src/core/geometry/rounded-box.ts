import { CornerRadius } from "../dsl/types";

export type Radii4 = [number, number, number, number];

export function parseCornerRadii(radius: CornerRadius | undefined): Radii4 {
  if (radius === undefined || radius === null) return [0, 0, 0, 0];
  if (typeof radius === "number") {
    const r = Math.max(0, radius);
    return [r, r, r, r];
  }
  if (Array.isArray(radius)) {
    return [
      Math.max(0, radius[0] || 0),
      Math.max(0, radius[1] || 0),
      Math.max(0, radius[2] || 0),
      Math.max(0, radius[3] || 0)
    ];
  }
  return [0, 0, 0, 0];
}

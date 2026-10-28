import { DEFAULT_DASH, Stroke, StrokeSide } from "../dsl/types";

export interface ResolvedStrokeWeights {
  top: number;
  right: number;
  bottom: number;
  left: number;
  isUniform: boolean;
}

export function resolveStrokeWeights(stroke: Stroke): ResolvedStrokeWeights {
  const w = Math.max(0, stroke.width ?? 1);
  const side: StrokeSide = stroke.side ?? "all";

  if (side === "top") {
    return { top: w, right: 0, bottom: 0, left: 0, isUniform: false };
  }
  if (side === "right") {
    return { top: 0, right: w, bottom: 0, left: 0, isUniform: false };
  }
  if (side === "bottom") {
    return { top: 0, right: 0, bottom: w, left: 0, isUniform: false };
  }
  if (side === "left") {
    return { top: 0, right: 0, bottom: 0, left: w, isUniform: false };
  }
  if (side === "custom") {
    const s = stroke.sides;
    const top = Math.max(0, s?.top ?? 0);
    const right = Math.max(0, s?.right ?? 0);
    const bottom = Math.max(0, s?.bottom ?? 0);
    const left = Math.max(0, s?.left ?? 0);
    const isUniform = top === right && right === bottom && bottom === left && left === w;
    return { top, right, bottom, left, isUniform };
  }

  return { top: w, right: w, bottom: w, left: w, isUniform: true };
}

/** SVG attributes every stroked path needs, derived from one stroke layer. */
export interface StrokeDashAttrs {
  strokeDasharray?: string;
  strokeDashoffset?: string;
  strokeMiterlimit?: number;
  strokeLinecap?: Stroke["cap"];
  strokeLinejoin?: Stroke["join"];
}

/**
 * Dash, cap and join for one stroke layer.
 *
 * `dashArray` is the real setting and `style: "dashed"` is only its shorthand, so
 * the array wins whenever it is present — including when it says "no dashes", in
 * which case a co-equal `style: "dashed"` must not reinstate them. A pattern of
 * all zeros is meaningless (the dash would never advance), so it counts as none.
 */
export function strokeDashAttrs(s: Stroke): StrokeDashAttrs {
  const pattern =
    s.dashArray && s.dashArray.length > 0 && s.dashArray.some((v) => v > 0)
      ? s.dashArray
      : s.style === "dashed" && !(s.dashArray && s.dashArray.length > 0)
        ? [...DEFAULT_DASH]
        : null;
  return {
    ...(pattern ? { strokeDasharray: pattern.join(" ") } : {}),
    ...(pattern && s.dashOffset ? { strokeDashoffset: String(s.dashOffset) } : {}),
    ...(s.miterLimit !== undefined ? { strokeMiterlimit: s.miterLimit } : {}),
    ...(s.cap ? { strokeLinecap: s.cap } : {}),
    ...(s.join ? { strokeLinejoin: s.join } : {})
  };
}

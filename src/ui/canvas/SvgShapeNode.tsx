import { JSX } from "preact";
import { DesignElement, Paint } from "../../core/dsl/types";
import { isGradientPaint } from "../../core/geometry/gradient-utils";
import { isNeutralColorFilter } from "../../core/dsl/color-filter";
import { cornerRadiiOf } from "../../core/geometry/shape-path";
import { resolveStrokeWeights, strokeDashAttrs } from "../../core/geometry/stroke-utils";
import { hexToRgb, parseBlendFlood, parseColorAlpha, rgbToHex } from "../../core/geometry/color-utils";
import { renderNonUniformStroke } from "./non-uniform-stroke";
import { CANVAS_ON_SELECT } from "./canvas-colors";

export function isIdentityBlendPaint(f: Paint): boolean {
  if (f.type !== "solid") return false;
  const c = f.color.trim().toLowerCase();
  const isWhite =
    c === "#fff" ||
    c === "#ffffff" ||
    c === "rgb(255, 255, 255)" ||
    c === "rgb(255,255,255)" ||
    c === "rgba(255, 255, 255, 1)" ||
    c === "rgba(255,255,255,1)";
  if (isWhite && (f.blendMode === "multiply" || f.blendMode === "color-burn")) return true;
  const isBlack =
    c === "#000" ||
    c === "#000000" ||
    c === "rgb(0, 0, 0)" ||
    c === "rgb(0,0,0)" ||
    c === "rgba(0, 0, 0, 1)" ||
    c === "rgba(0,0,0,1)";
  if (isBlack && (f.blendMode === "screen" || f.blendMode === "color-dodge")) return true;
  return false;
}

export function resolveSolidPaintBlend(
  f: Paint,
  activeFills: Paint[],
  hasGlass: boolean,
  isMaskStencil: boolean
): { fillVal?: string; opacity: number; blendMode?: string } {
  const isIdentityBlend = isIdentityBlendPaint(f);
  const rawOpacity = typeof f.opacity === "number" ? f.opacity : 1;
  if (isIdentityBlend) {
    return { opacity: 0, blendMode: undefined };
  }
  if (f.type !== "solid") {
    return {
      opacity: rawOpacity,
      blendMode: f.blendMode && f.blendMode !== "normal" ? f.blendMode : undefined
    };
  }
  if (!isMaskStencil && (f.blendMode === "plus-lighter" || f.blendMode === "color-burn")) {
    const { floodColor, floodOpacity, effectiveBlendMode } = parseBlendFlood(f.color, f.blendMode);
    const netOpacity = rawOpacity * floodOpacity;
    const isOpaqueWhiteAdd =
      effectiveBlendMode === "plus-lighter" &&
      floodColor.toLowerCase() === "#ffffff" &&
      netOpacity >= 0.999;
    return {
      fillVal: floodColor,
      opacity: netOpacity,
      blendMode:
        !isOpaqueWhiteAdd && effectiveBlendMode && effectiveBlendMode !== "normal"
          ? effectiveBlendMode
          : undefined
    };
  }
  const isBlendOnlyStack =
    !isMaskStencil &&
    activeFills.length > 0 &&
    activeFills.every((p) => Boolean(p.blendMode && p.blendMode !== "normal"));
  if (isBlendOnlyStack && (f.blendMode === "lighten" || f.blendMode === "screen")) {
    const { hex6, alphaPct } = parseColorAlpha(f.color);
    const { r, g, b } = hexToRgb(hex6);
    const m = Math.max(r, g, b) / 255;
    if (m <= 0) return { fillVal: "#000000", opacity: 0, blendMode: undefined };
    const scale = f.blendMode === "lighten" ? 0.15 : 1;
    return {
      fillVal: rgbToHex(r / m, g / m, b / m),
      opacity: Math.round(rawOpacity * (alphaPct / 100) * m * scale * 1000) / 1000,
      blendMode: f.blendMode
    };
  }
  const isBaseLessBlendStack =
    isBlendOnlyStack &&
    activeFills.length > 1 &&
    activeFills.some((p) => p.blendMode === "luminosity");
  if (isBaseLessBlendStack && f.blendMode === "color-dodge") {
    const { hex6, alphaPct } = parseColorAlpha(f.color);
    const { r, g, b } = hexToRgb(hex6);
    const m = Math.max(r, g, b) / 255;
    if (m <= 0) return { fillVal: "#000000", opacity: 0, blendMode: undefined };
    return {
      fillVal: rgbToHex(r / m, g / m, b / m),
      opacity: rawOpacity * (alphaPct / 100) * m * 0.2,
      blendMode: "color-dodge"
    };
  }
  if (isBaseLessBlendStack && f.blendMode === "luminosity") {
    const dodgeFill = activeFills.find((p) => p.type === "solid" && p.blendMode === "color-dodge") as
      | (Paint & { type: "solid" })
      | undefined;
    if (dodgeFill) {
      const { hex6, alphaPct } = parseColorAlpha(dodgeFill.color);
      const { r, g, b } = hexToRgb(hex6);
      const dodgeFactor = Math.min(
        0.85,
        (typeof dodgeFill.opacity === "number" ? dodgeFill.opacity : 1) *
          (alphaPct / 100) *
          (Math.max(r, g, b) / 255)
      );
      const netDarkAlpha = Math.max(0.08, 1 - (1 - rawOpacity) / (1 - dodgeFactor));
      return {
        fillVal: f.color,
        opacity: netDarkAlpha,
        blendMode: "luminosity"
      };
    }
  }
  return {
    fillVal: f.color,
    opacity: rawOpacity,
    blendMode: f.blendMode && f.blendMode !== "normal" ? f.blendMode : undefined
  };
}

export function renderFills(
  el: DesignElement,
  activeFills: Paint[],
  shapeLocalD: string,
  fillRule: any,
  fillLayerIndex: (f: Paint, fallback: number) => number,
  resolveAssetUri: (assetId: string) => string | undefined,
  isMaskStencil: boolean,
  hasGlass = false
): JSX.Element[] | JSX.Element | null {
  if (activeFills.length === 0) {
    if (isMaskStencil) return <path d={shapeLocalD} fill={CANVAS_ON_SELECT} />;
    return null;
  }
  return activeFills.map((f, idx) => {
    let fillVal = "none";
    let layerFilter: string | undefined;
    const resolved = resolveSolidPaintBlend(f, activeFills, hasGlass, isMaskStencil);
    if (f.type === "solid") {
      fillVal = resolved.fillVal ?? f.color;
    } else if (isGradientPaint(f)) {
      fillVal = `url(#grad_fill_${el.id}_${fillLayerIndex(f, idx)})`;
    } else if (f.type === "image") {
      // A missing bitmap leaves the layer unpainted rather than filling it
      // with the broken-reference black SVG would use.
      const uri = resolveAssetUri(f.assetId);
      if (uri) {
        const layerIdx = fillLayerIndex(f, idx);
        fillVal = `url(#pat_${el.id}_${layerIdx})`;
        if (f.adjust && !isNeutralColorFilter(f.adjust)) {
          layerFilter = `url(#paintfilter_${el.id}_${layerIdx})`;
        }
      }
    } else if (f.type === "pattern") {
      fillVal = `url(#pat_${el.id}_${fillLayerIndex(f, idx)})`;
    }
    return (
      <path
        key={idx}
        d={shapeLocalD}
        fill={fillVal}
        filter={layerFilter}
        fillOpacity={resolved.opacity}
        fillRule={fillRule}
        style={resolved.blendMode ? { mixBlendMode: resolved.blendMode as any } : undefined}
      />
    );
  });
}

export function renderStrokes(
  el: DesignElement,
  activeStrokes: any[],
  shapeLocalD: string,
  strokeLayerIndex: (s: any, fallback: number) => number
): (JSX.Element | null)[] | null {
  if (activeStrokes.length === 0) return null;
  const isRectangular = el.type === "rect" || el.type === "frame" || el.type === "component";

  return activeStrokes.map((s: any, idx: number) => {
    const resolvedPaint = s.paint ? resolveSolidPaintBlend(s.paint, [s.paint], false, false) : null;
    let rawColor =
      (s.paint?.type === "solid" ? resolvedPaint?.fillVal ?? s.paint.color : undefined) ||
      s.color ||
      CANVAS_ON_SELECT;
    let strokeColorAttr = rawColor;
    if (s.paint && isGradientPaint(s.paint)) {
      strokeColorAttr = `url(#grad_stroke_${el.id}_${strokeLayerIndex(s, idx)})`;
    } else if (s.paint?.type === "pattern") {
      strokeColorAttr = `url(#pat_stroke_${el.id}_${strokeLayerIndex(s, idx)})`;
    }
    const strokeWidth = s.width || 1;
    const strokeAlign = s.align || "center";
    const baseStrokeOpacity = typeof s.opacity === "number" ? s.opacity : 1;
    const strokeOpacity = resolvedPaint ? baseStrokeOpacity * resolvedPaint.opacity : baseStrokeOpacity;
    const strokeBlendStyle = resolvedPaint?.blendMode ? { mixBlendMode: resolvedPaint.blendMode as any } : undefined;
    const strokeCapJoin = strokeDashAttrs(s);

    const weights = isRectangular ? resolveStrokeWeights(s) : null;
    if (weights && !weights.isUniform) {
      return renderNonUniformStroke(
        weights,
        { width: el.width, height: el.height, radii: cornerRadiiOf((el as any).borderRadius, el.width, el.height) },
        strokeColorAttr,
        strokeAlign as any,
        strokeCapJoin,
        strokeOpacity,
        `clip_stroke_in_${el.id}`,
        `mask_stroke_out_${el.id}`,
        idx
      );
    }

    if (strokeAlign === "inside") {
      return (
        <path
          key={idx}
          d={shapeLocalD}
          fill="none"
          stroke={strokeColorAttr}
          strokeWidth={strokeWidth * 2}
          strokeOpacity={strokeOpacity}
          clipPath={`url(#clip_stroke_in_${el.id})`}
          style={strokeBlendStyle}
          {...strokeCapJoin}
        />
      );
    }
    if (strokeAlign === "outside") {
      return (
        <path
          key={idx}
          d={shapeLocalD}
          fill="none"
          stroke={strokeColorAttr}
          strokeWidth={strokeWidth * 2}
          strokeOpacity={strokeOpacity}
          mask={`url(#mask_stroke_out_${el.id})`}
          style={strokeBlendStyle}
          {...strokeCapJoin}
        />
      );
    }
    return (
      <path
        key={idx}
        d={shapeLocalD}
        fill="none"
        stroke={strokeColorAttr}
        strokeWidth={strokeWidth}
        strokeOpacity={strokeOpacity}
        style={strokeBlendStyle}
        {...strokeCapJoin}
      />
    );
  });
}

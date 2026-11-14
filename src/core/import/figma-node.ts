import type { AutoLayout, DesignElement, ElementSizing, LayoutConstraints, LayoutGuide, Paint, Stroke } from "../dsl/types";
import { mapFigmaGridChild, mapFigmaGridLayout } from "./figma-grid";
import { EFFECT_BLEND_MODES, figmaBlendMode, mapFigmaCornerRadius, mapFigmaEffects, mapFigmaFills, mapFigmaPaint, mapFigmaStrokeAsFills, mapFigmaStrokes, type PaintPlacement } from "./figma-paint";
import { figmaFillIsTurned } from "./figma-image-fill";
import { fillTextElement } from "./figma-text";
import { figmaGeometry } from "./figma-geometry";
import { mapFigmaSlideTransition } from "./figma-slide";
import type { FigmaAssetStore } from "./figma-assets";
import type { FigmaGap, FigmaNode, FigmaPaint, Rect } from "./figma-types";
import type { FigmaTokens } from "./figma-tokens";
import type { FigmaStyleIndex } from "./figma-styles";
import { flattenLayout, toCssLine } from "../dsl/layout-flat";
import { sanitizeElementId } from "../id";
import {
  analyzeNodeTransform,
  carryRotation,
  figmaLineRotation,
  placeNode,
  round2,
  type NodeTransform,
  type ParentContext
} from "./figma-node-transform";

export type { ParentContext };

export interface NodeWalkState {
  measured: Map<string, Rect>;
  gaps: FigmaGap[];
  imageRefs: string[];
  elementCount: number;
  maxElements: number;
  usedIds: Set<string>;
  images?: FigmaAssetStore;
  tokens?: FigmaTokens;
  styles?: FigmaStyleIndex;
}

function bindFigmaTokens(node: FigmaNode, out: Draft, state: NodeWalkState): void {
  const tokens = state.tokens;
  if (!tokens) return;
  const lookup = tokens.lookup(node);

  const fills = out.fills as Paint[] | undefined;
  if (Array.isArray(fills)) {
    for (let i = 0; i < fills.length; i++) {
      const tokenId = lookup.paint("fills", i);
      if (tokenId) fills[i] = { ...fills[i], tokenId };
    }
  }
  const strokes = out.strokes as Stroke[] | undefined;
  if (Array.isArray(strokes)) {
    for (let i = 0; i < strokes.length; i++) {
      const tokenId = lookup.paint("strokes", i);
      if (tokenId) strokes[i] = { ...strokes[i], tokenId };
    }
  }

  const bindings: Record<string, string> = {};
  for (const { field, tokenId } of lookup.scalars()) {
    // First writer wins: Figma binds `cornerRadius` and the four corners at once.
    if (bindings[field]) continue;
    bindings[field] = tokenId;
  }
  if (Object.keys(bindings).length > 0) {
    out.tokenBindings = { ...(out.tokenBindings as Record<string, string> | undefined), ...bindings };
  }
}

function bindFigmaStyles(node: FigmaNode, out: Draft, state: NodeWalkState): void {
  const index = state.styles;
  const channels = node.styles;
  if (!index || !channels) return;

  const fill = index.link(channels.fill);
  if (fill) out.fillStyleId = fill;
  const stroke = index.link(channels.stroke);
  if (stroke) out.strokeStyleId = stroke;
  const effect = index.link(channels.effect);
  if (effect) out.effectStyleId = effect;
  if (out.type === "text") {
    const text = index.link(channels.text);
    if (text) out.textStyleId = text;
  }
  // Surface unsupported grid styles in the gap report.
  index.link(channels.grid);
}

const JUSTIFY: Record<string, AutoLayout["justify"]> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "space-between",
  SPACE_AROUND: "space-around",
  SPACE_EVENLY: "space-evenly"
};

const ALIGN: Record<string, AutoLayout["align"]> = { MIN: "start", CENTER: "center", MAX: "end" };
const ALIGN_SELF: Record<string, NonNullable<AutoLayout["align"]>> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  STRETCH: "stretch"
};
const GRID_ALIGN: Record<string, NonNullable<AutoLayout["align"]>> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end"
};

function gridChildAlign(node: FigmaNode, state: NodeWalkState): AutoLayout["align"] {
  const h = GRID_ALIGN[node.gridChildHorizontalAlign ?? ""];
  const v = GRID_ALIGN[node.gridChildVerticalAlign ?? ""];
  if (h && v && h !== v) gap(state, node, "grid:childAlign", `the DSL aligns a grid child on one axis; ${h}/${v} cannot both be kept`);
  return h ?? v;
}

export function mapFigmaAutoLayout(node: FigmaNode, state?: NodeWalkState): AutoLayout | undefined {
  if (node.layoutMode === "GRID") {
    return mapFigmaGridLayout(node, state?.gaps);
  }
  if (!node.layoutMode || node.layoutMode === "NONE") return undefined;
  const direction: "row" | "column" = node.layoutMode === "HORIZONTAL" ? "row" : "column";
  const layout: AutoLayout = {
    mode: "flex",
    direction,
    gap: node.itemSpacing ?? 0,
    padding: [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0],
    justify: JUSTIFY[node.primaryAxisAlignItems ?? ""] ?? "start",
    align: ALIGN[node.counterAxisAlignItems ?? ""] ?? "start"
  };
  if (node.layoutWrap === "WRAP") layout.wrap = "wrap";
  const crossGap = node.counterAxisSpacing;
  if (crossGap !== undefined) {
    if (direction === "row") layout.rowGap = crossGap;
    else layout.columnGap = crossGap;
  }
  return layout;
}

function mapFigmaSizing(node: FigmaNode, state: NodeWalkState, parentLayoutMode?: string): ElementSizing | undefined {
  const sizing: ElementSizing = {};
  let any = false;
  const one = (raw: string | undefined): "fixed" | "fit-content" | "fill" | undefined => {
    if (raw === "FIXED") return "fixed";
    if (raw === "HUG") return "fit-content";
    if (raw === "FILL") return "fill";
    return undefined;
  };
  const w = one(node.layoutSizingHorizontal);
  const h = one(node.layoutSizingVertical);
  if (w) (sizing as { width?: string }).width = w;
  if (h) (sizing as { height?: string }).height = h;
  if (w || h) any = true;

  if (!w && !h && (node.layoutGrow ?? 0) > 0) {
    if (parentLayoutMode === "HORIZONTAL") {
      (sizing as Record<string, string>).width = "fill";
      any = true;
    } else if (parentLayoutMode === "VERTICAL") {
      (sizing as Record<string, string>).height = "fill";
      any = true;
    } else if (parentLayoutMode === "GRID") {
      gap(state, node, "layoutGrow:grid", "a grid child is placed by the grid's tracks; `layoutGrow` has no DSL meaning inside one");
    }
  }

  const bounds: Array<[keyof ElementSizing, number | undefined]> = [
    ["minWidth", node.minWidth],
    ["maxWidth", node.maxWidth],
    ["minHeight", node.minHeight],
    ["maxHeight", node.maxHeight]
  ];
  for (const [key, value] of bounds) {
    if (typeof value !== "number") continue;
    // A zero minimum is Figma's "no floor" and would pin the axis shut.
    if (key.startsWith("min") && value === 0) continue;
    (sizing as Record<string, number>)[key as string] = value;
    any = true;
  }

  return any ? sizing : undefined;
}

function huggingAxes(node: FigmaNode): Partial<ElementSizing> | undefined {
  const out: Partial<ElementSizing> = {};
  if (node.primaryAxisSizingMode === "AUTO") {
    out[isRowLayout(node) ? "width" : "height"] = "fit-content";
  }
  if (node.counterAxisSizingMode === "AUTO") {
    out[isRowLayout(node) ? "height" : "width"] = "fit-content";
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const isRowLayout = (node: FigmaNode): boolean => node.layoutMode === "HORIZONTAL";

function mapConstraints(node: FigmaNode): DesignElement["constraints"] {
  const horizontal = CONSTRAINT_H[node.constraints?.horizontal ?? ""];
  const vertical = CONSTRAINT_V[node.constraints?.vertical ?? ""];
  if (!horizontal && !vertical && !node.preserveRatio) return undefined;
  return {
    ...(horizontal ? { horizontal } : {}),
    ...(vertical ? { vertical } : {}),
    ...(node.preserveRatio ? { preserveAspectRatio: true } : {})
  };
}

const CONSTRAINT_H: Record<string, NonNullable<LayoutConstraints["horizontal"]>> = {
  MIN: "left",
  LEFT: "left",
  MAX: "right",
  RIGHT: "right",
  CENTER: "center",
  STRETCH: "stretch",
  LEFT_RIGHT: "stretch",
  SCALE: "scale"
};

const CONSTRAINT_V: Record<string, NonNullable<LayoutConstraints["vertical"]>> = {
  MIN: "top",
  TOP: "top",
  MAX: "bottom",
  BOTTOM: "bottom",
  CENTER: "center",
  STRETCH: "stretch",
  TOP_BOTTOM: "stretch",
  SCALE: "scale"
};

function gap(state: NodeWalkState, node: FigmaNode, property: string, value?: string): void {
  state.gaps.push({ id: node.id, name: node.name || node.type, property, value });
}

export function collectImageRef(node: FigmaNode, into: string[]): void {
  if (node.type !== "IMAGE") return;
  for (const fill of node.fills ?? []) {
    if (fill.type === "IMAGE" && typeof fill.imageRef === "string" && fill.imageRef) into.push(fill.imageRef);
  }
}

type Draft = Record<string, unknown> & { id: string; x: number; y: number; width: number; height: number };

function base(node: FigmaNode, rect: Rect, parentX: number, parentY: number, xform: NodeTransform): Draft {
  const out: Draft = {
    id: sanitizeElementId(node.id),
    name: node.name || node.type,
    x: round2(rect.x - parentX),
    y: round2(rect.y - parentY),
    width: round2(rect.width),
    height: round2(rect.height)
  };
  if (node.opacity !== undefined && node.opacity !== 1) out.opacity = node.opacity;
  if (node.visible === false) out.visible = false;
  if (node.blendMode) {
    const blend = figmaBlendMode(node.blendMode);
    if (blend && blend !== "normal") out.blendMode = blend;
  }
  // A line absorbs flips into its angle via `figmaLineRotation`.
  if (node.type !== "LINE") {
    if (xform.flipY) out.flipY = true;
    const fields = xform.fields;
    if (fields && (fields.skewX !== undefined || fields.skewY !== undefined)) {
      if (fields.skewX !== undefined) out.skewX = fields.skewX;
      if (fields.skewY !== undefined) out.skewY = fields.skewY;
      if (Math.abs(fields.rotation) > 0.01) out.rotation = round2(fields.rotation);
    }
  }
  if (node.isMask) out.isMask = true;
  const maskMode = MASK_MODES[node.maskType ?? ""];
  if (maskMode) out.maskMode = maskMode;
  return out;
}

const MASK_MODES: Record<string, DesignElement["maskMode"]> = {
  ALPHA: "alpha",
  LUMINANCE: "luminance"
};

function unmappedPaintReason(fill: FigmaPaint, state: NodeWalkState): string | undefined {
  if (fill.type === "IMAGE") return state.images?.reason(fill.imageRef ?? "");
  return UNMAPPED_PAINT_NOTES[fill.type ?? ""];
}

const UNMAPPED_PAINT_NOTES: Record<string, string> = {
  VIDEO:
    "Figma's plugin API cannot read a video fill's bytes, and this export carries no poster frame for it either, so this layer keeps its box and loses its picture",
  PATTERN:
    "a pattern fill names a source node rather than a motif, and the source's own pixels do not travel with the export, so this layer keeps its box and loses its pattern"
};

function paintOf(node: FigmaNode, out: Draft, state: NodeWalkState): void {
  const resolve = (ref: string) => state.images?.idFor(ref);
  const placement: PaintPlacement = {
    box: { width: out.width, height: out.height },
    naturalOf: (assetId) => {
      const asset = state.images?.assets.find((a) => a.id === assetId);
      return asset?.width && asset?.height ? { width: asset.width, height: asset.height } : null;
    }
  };
  const fills = mapFigmaFills(node.fills, resolve, placement);
  if (fills) out.fills = fills;
  const stroke = mapFigmaStrokes(node, placement.box);
  if (stroke) Object.assign(out, stroke);
  // In Figma, BACKGROUND_BLUR is gated by the layer's own visible fill.
  const activeEffects = hasVisiblePaint(node.fills)
    ? node.effects
    : node.effects?.filter((e) => e.type !== "BACKGROUND_BLUR");
  const effects = mapFigmaEffects(activeEffects);
  if (effects) out.effects = effects;

  for (const fill of node.fills ?? []) {
    if (fill.visible === false || !fill.type) continue;
    const mapped = mapFigmaPaint(fill, resolve, placement);
    const carried = mapped !== null;
    if (
      mapped?.type === "image" &&
      fill.type === "IMAGE" &&
      mapped.fit !== "crop" &&
      (fill.scaleMode === "TILE" || fill.scaleMode === "CROP")
    ) {
      gap(
        state,
        node,
        `image:scaleMode:${fill.scaleMode}`,
        fill.scaleMode === "TILE"
          ? "tiled image fills have no DSL paint, so the bitmap is drawn as one flat cover"
          : "this crop's framing cannot be written as a DSL crop — the image is scaled unevenly, mirrored, or its size was never recorded — so the bitmap is drawn as a cover"
      );
      continue;
    }
    if (mapped?.type === "image" && mapped.fit !== "crop" && figmaFillIsTurned(fill)) {
      gap(
        state,
        node,
        "image:fillRotation",
        "the bitmap is turned inside its layer, which needs the box and the image's recorded size, so the bitmap is drawn square to the box"
      );
    }
    const expressible = carried || ["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].includes(fill.type);
    if (!expressible) gap(state, node, `fills:${fill.type}`, unmappedPaintReason(fill, state));
  }
  for (const effect of node.effects ?? []) {
    if (effect.visible === false) continue;
    if (!MAPPED_EFFECTS.has(effect.type)) {
      gap(state, node, `effects:${effect.type}`);
      continue;
    }
    if (typeof effect.blendMode === "string" && !EFFECT_BLEND_MODES.has(effect.blendMode)) {
      gap(
        state,
        node,
        `effects:blendMode:${effect.blendMode}`,
        "this effect's blend mode has no DSL spelling, so the effect is not painted"
      );
    }
  }
}

const MAPPED_EFFECTS = new Set(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR", "GLASS"]);

function mapLine(node: FigmaNode, rect: Rect, parentX: number, parentY: number, state: NodeWalkState, ownSpace: boolean, xform: NodeTransform): Draft {
  const out = base(node, rect, parentX, parentY, xform);
  out.type = "line";
  out.dx = round2(rect.width);
  out.dy = round2(rect.height);
  if (!ownSpace && rect.width !== 0 && rect.height !== 0) {
    gap(state, node, "line:direction", "the line is rotated and the response carries no `size`, so its direction is assumed top-left to bottom-right");
  }
  const rotation = figmaLineRotation(node, xform);
  if (typeof rotation === "number" && Math.abs(rotation) > 0.01) out.rotation = round2(rotation);
  const strokes = mapFigmaStrokes(node);
  if (strokes) Object.assign(out, strokes);
  else out.strokes = [{ color: "#000000", width: 1, enabled: true }];
  return out;
}

function mapVector(node: FigmaNode, rect: Rect, parentX: number, parentY: number, state: NodeWalkState, xform: NodeTransform): Draft {
  const out = base(node, rect, parentX, parentY, xform);
  out.type = "path";
  // Outline-only vectors keep degenerate slivers in `fillGeometry`; use expanded `strokeGeometry`.
  const strokeOnly = !hasVisiblePaint(node.fills) && hasVisiblePaint(node.strokes);
  const geometry = figmaGeometry(
    (strokeOnly ? node.strokeGeometry : node.fillGeometry) ?? node.strokeGeometry ?? node.fillGeometry
  );
  if (geometry) {
    out.d = geometry.d;
    if (geometry.fillRule) out.fillRule = geometry.fillRule;
    if (geometry.mixedWinding) {
      gap(
        state,
        node,
        "path:geometry:mixedWinding",
        "this vector's regions carry different winding rules and an element has one, so `evenodd` is used for all of them — regions that overlap will punch each other out"
      );
    }
  } else {
    gap(state, node, "path:geometry", "the export carries no vector geometry for this layer");
    out.d = "";
  }
  paintOf(node, out, state);
  if (strokeOnly) {
    delete out.strokes;
    const asFills = mapFigmaStrokeAsFills(node, { width: rect.width, height: rect.height });
    if (asFills) out.fills = asFills;
  }
  return out;
}

function hasVisiblePaint(paints: FigmaPaint[] | undefined): boolean {
  return Array.isArray(paints) && paints.some((p) => !!p && p.visible !== false && !!p.type);
}

const FIGMA_GUIDE_ALIGN: Record<string, LayoutGuide["align"]> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  STRETCH: "stretch"
};

/** Emit `#RRGGBBAA` rather than `rgba()` so guide colors match `fills` validation. */
function guideColor(c: { r?: number; g?: number; b?: number; a?: number } | undefined): string | undefined {
  if (!c) return undefined;
  const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");
  const alpha = c.a ?? 1;
  const rgb = `#${byte(c.r ?? 0)}${byte(c.g ?? 0)}${byte(c.b ?? 0)}`;
  return alpha >= 1 ? rgb : `${rgb}${byte(alpha)}`;
}

function mapFigmaLayoutGuides(node: FigmaNode, state: NodeWalkState): LayoutGuide[] {
  const grids = node.layoutGrids;
  if (!Array.isArray(grids)) return [];

  const guides: LayoutGuide[] = [];
  for (const grid of grids) {
    const pattern = String(grid.pattern ?? "");
    const hidden = grid.visible === false ? { visible: false } : {};
    const color = guideColor(grid.color);
    const colour = color ? { color } : {};

    if (pattern === "GRID") {
      const size = typeof grid.sectionSize === "number" ? grid.sectionSize : 0;
      if (size <= 0) {
        gap(state, node, "layoutGrid:grid without sectionSize", pattern);
        continue;
      }
      guides.push({ kind: "grid", size, ...colour, ...hidden });
      continue;
    }

    const kind = pattern === "COLUMNS" ? "columns" : pattern === "ROWS" ? "rows" : null;
    if (!kind) {
      gap(state, node, "layoutGrid:pattern", pattern);
      continue;
    }
    const count = typeof grid.count === "number" ? grid.count : 0;
    if (count < 1) {
      gap(state, node, "layoutGrid:noCount", pattern);
      continue;
    }

    const align = FIGMA_GUIDE_ALIGN[String(grid.alignment ?? "STRETCH")] ?? "stretch";
    const guide: LayoutGuide = { kind, count, align };
    if (align !== "stretch") {
      const size = typeof grid.sectionSize === "number" ? grid.sectionSize : 0;
      if (size <= 0) {
        gap(state, node, "layoutGrid:fixed alignment without sectionSize", pattern);
        continue;
      }
      if (kind === "columns") guide.width = size;
      else guide.height = size;
    }
    if (typeof grid.gutterSize === "number" && grid.gutterSize > 0) guide.gutter = grid.gutterSize;
    if (typeof grid.offset === "number" && grid.offset > 0) guide.margin = grid.offset;
    guides.push({ ...guide, ...colour, ...hidden });
  }
  return guides;
}

function mapContainer(node: FigmaNode, rect: Rect, parentX: number, parentY: number, state: NodeWalkState, kind: "frame" | "component" | "componentSet", xform: NodeTransform): Draft {
  const out = base(node, rect, parentX, parentY, xform);
  out.type = kind;
  out.children = [];
  if (node.clipsContent) out.overflow = "hidden";
  const radius = mapFigmaCornerRadius(node);
  if (radius !== undefined) out.borderRadius = radius;
  if (typeof node.cornerSmoothing === "number" && node.cornerSmoothing > 0) out.cornerSmoothing = node.cornerSmoothing;
  if (kind !== "componentSet") {
    const guides = mapFigmaLayoutGuides(node, state);
    if (guides.length > 0) out.layoutGuides = guides;
  }
  paintOf(node, out, state);
  const layout = mapFigmaAutoLayout(node, state);
  if (layout) Object.assign(out, flattenLayout(layout));

  if (node.type === "INSTANCE") {
    out.metadata = { figmaComponentId: sanitizeElementId(node.componentId ?? "") };
  }
  return out;
}

function mapRectNode(node: FigmaNode, rect: Rect, parentX: number, parentY: number, state: NodeWalkState, xform: NodeTransform, includeSmoothing: boolean): Draft {
  const out = base(node, rect, parentX, parentY, xform);
  out.type = "rect";
  const radius = mapFigmaCornerRadius(node);
  if (radius !== undefined) out.borderRadius = radius;
  if (includeSmoothing && typeof node.cornerSmoothing === "number" && node.cornerSmoothing > 0) {
    out.cornerSmoothing = node.cornerSmoothing;
  }
  paintOf(node, out, state);
  return out;
}

export function mapFigmaNode(
  node: FigmaNode,
  parentX: number,
  parentY: number,
  state: NodeWalkState,
  parent?: ParentContext
): DesignElement | null {
  if (node.visible === false) return null;
  if (state.elementCount >= state.maxElements) {
    gap(state, node, "document:maxElements", String(state.maxElements));
    return null;
  }

  const xform = analyzeNodeTransform(node);
  const placed = placeNode(node, parent, xform, (n, prop, val) => gap(state, n, prop, val));
  if (!placed) {
    if (node.type !== "DOCUMENT" && node.type !== "CANVAS") gap(state, node, "node:noBounds", node.type);
    return null;
  }
  const rect = placed.rect;
  const originX = placed.local ? 0 : parentX;
  const originY = placed.local ? 0 : parentY;

  let out: Draft | null = null;

  switch (node.type) {
    case "FRAME":
    case "GROUP":
    case "SECTION":
    case "INSTANCE":
    case "BRUSH":
    case "SLICE":
      out = mapContainer(node, rect, originX, originY, state, "frame", xform);
      break;
    case "SLIDE": {
      out = mapContainer(node, rect, originX, originY, state, "frame", xform);
      const slide = mapFigmaSlideTransition(node.slideTransition);
      if (slide.spec) out.slide = slide.spec;
      for (const note of slide.gaps) gap(state, node, note.property, note.value);
      break;
    }
    case "COMPONENT":
      out = mapContainer(node, rect, originX, originY, state, "component", xform);
      break;
    case "COMPONENT_SET":
      out = mapContainer(node, rect, originX, originY, state, "componentSet", xform);
      break;
    case "TEXT":
      out = fillTextElement(base(node, rect, originX, originY, xform), node, state);
      paintOf(node, out, state);
      // Keep explicit empty fills so text doesn't inherit `style.color` default black.
      if (out.fills === undefined) out.fills = [];
      break;
    case "RECTANGLE":
      out = mapRectNode(node, rect, originX, originY, state, xform, true);
      break;
    case "ELLIPSE": {
      const ellipse = base(node, rect, originX, originY, xform);
      ellipse.type = "ellipse";
      paintOf(node, ellipse, state);
      out = ellipse;
      break;
    }
    case "LINE":
      out = mapLine(node, rect, originX, originY, state, placed.ownSpace, xform);
      break;
    case "VECTOR":
    case "BOOLEAN_OPERATION":
    case "STAR":
    case "REGULAR_POLYGON":
    case "STAR_POLYGON":
    case "POLYGON":
      out = mapVector(node, rect, originX, originY, state, xform);
      break;
    case "IMAGE":
      out = mapRectNode(node, rect, originX, originY, state, xform, false);
      break;
    default:
      if (node.children?.length) {
        out = mapContainer(node, rect, originX, originY, state, "frame", xform);
        gap(state, node, `node:type:${node.type}`);
      } else {
        gap(state, node, `node:type:${node.type}`);
        return null;
      }
  }

  if (!out) return null;

  // Empty ALPHA/LUMINANCE leaf masks paint zero alpha instead of falling back to white stencil.
  if (
    node.isMask &&
    (node.maskType === "ALPHA" || node.maskType === "LUMINANCE") &&
    !node.children?.length &&
    out.fills === undefined &&
    !hasVisiblePaint(node.fills) &&
    !hasVisiblePaint(node.strokes)
  ) {
    out.fills = [{ type: "solid", color: "#000000", opacity: 0 }];
  }

  bindFigmaTokens(node, out, state);
  bindFigmaStyles(node, out, state);

  const hug = huggingAxes(node);
  const sizing = mapFigmaSizing(node, state, parent?.layoutMode);
  if (sizing || hug) out.sizing = { ...(out.sizing ?? {}), ...hug, ...sizing };
  carryRotation(out, placed.rotation);
  const constraints = mapConstraints(node);
  if (constraints) out.constraints = constraints;
  if (node.layoutPositioning === "ABSOLUTE") out.position = "absolute";
  const alignSelf = node.layoutAlign ? ALIGN_SELF[node.layoutAlign] : undefined;
  if (alignSelf) out["align-self"] = toCssLine(alignSelf);
  const cell = mapFigmaGridChild(node);
  if (cell?.layoutCell) out["grid-area"] = cell.layoutCell;
  const gridAlign = gridChildAlign(node, state);
  if (gridAlign && !alignSelf) out["align-self"] = toCssLine(gridAlign);

  state.elementCount += 1;
  state.measured.set(out.id, rect);
  if (!state.usedIds.has(out.id)) state.usedIds.add(out.id);

  if (node.type !== "BOOLEAN_OPERATION" && node.children && node.children.length > 0) {
    const childParent: ParentContext = { rotated: placed.ownSpace, layoutMode: node.layoutMode };
    const children: DesignElement[] = [];
    for (let i = 0; i < node.children.length; i++) {
      const mapped = mapFigmaNode(node.children[i], rect.x, rect.y, state, childParent);
      if (mapped !== null) children.push(mapped);
    }
    if (children.length > 0) {
      if (out.type === "frame" || out.type === "component" || out.type === "componentSet") {
        out.children = children;
      } else {
        gap(state, node, "node:mixedContent", node.type);
      }
    }
  }
  return out as unknown as DesignElement;
}

export type { Draft };

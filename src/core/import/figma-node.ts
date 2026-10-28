/**
 * Figma node → Design element.
 *
 * The DSL stores every `x` / `y` LOCAL to its parent container's origin, and
 * Figma reports only absolute canvas bounds, so each node's box is expressed
 * once against its parent's origin here. The ABSOLUTE box goes into
 * `state.measured` at the same time, because that is the ground truth
 * `verifyImport` replays the engine's own layout against — the same contract the
 * HTML importer meets by reading `getBoundingClientRect` behind an offset host.
 */

import type { AutoLayout, DesignElement, ElementSizing, LayoutConstraints, Paint, Stroke } from "../dsl/types";
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

export interface NodeWalkState {
  /** Absolute canvas box per produced id — the ground truth for `verifyImport`. */
  measured: Map<string, Rect>;
  gaps: FigmaGap[];
  /** Every image ref seen, for the caller to report and to resolve assets from. */
  imageRefs: string[];
  elementCount: number;
  maxElements: number;
  /** Figma node ids already taken, so a synthesized id never collides. */
  usedIds: Set<string>;
  /** Bytes resolved before the walk, for `IMAGE` layers' image fills. */
  images?: FigmaAssetStore;
  /**
   * The file's design tokens, built once from its variables so two layers bound
   * to the same variable land on the same token.
   */
  tokens?: FigmaTokens;
  /**
   * The file's published styles, minted on the first layer that points at one.
   * Separate from `tokens` because a style is a named bundle, not a value with
   * modes — a colour style and the variable behind it are two different links.
   */
  styles?: FigmaStyleIndex;
}

/**
 * Bind a node's variable bindings onto the element the mapper just built.
 *
 * Done here rather than inside `paintOf` and each branch because the binding is a
 * property of the NODE, not of any one mapping: a radius, a gap, a text size and
 * a fill are decided in four different places, and a token that is bound in one
 * branch and forgotten in the next is a token half a design system.
 *
 * Nothing here changes a value. Every field it touches was already written from
 * the resolved literal, and the token only says where the value came from —
 * which is what makes an edit to the token reach the layer afterwards.
 */
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
    // First writer wins: Figma binds `cornerRadius` and the four corners at once,
    // and the DSL holds one radius.
    if (bindings[field]) continue;
    bindings[field] = tokenId;
  }
  if (Object.keys(bindings).length > 0) {
    out.tokenBindings = { ...(out.tokenBindings as Record<string, string> | undefined), ...bindings };
  }
}

/**
 * Point a layer at the styles Figma says it uses.
 *
 * The values stay MATERIALISED beside the id, which is how the DSL already spells
 * a bound axis: every reader paints from the value, and the id is what makes an
 * edit to the style reach this layer afterwards. A reference alone would be a
 * layer nothing can draw until the cascade runs.
 */
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
  // A text style is only a text style on a text layer; a frame that carries the
  // id would be a reference the inspector cannot show and the renderer ignores.
  if (out.type === "text") {
    const text = index.link(channels.text);
    if (text) out.textStyleId = text;
  }
  // A GRID style has no FISH counterpart — a grid is a layout its container
  // carries, not a named preset — so asking anyway is what puts it in the report
  // as a named gap instead of letting the layer arrive with a silent hole.
  index.link(channels.grid);
}

const JUSTIFY: Record<string, AutoLayout["justify"]> = {  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "space-between",
  SPACE_AROUND: "space-around",
  // Not in the published OpenAPI enum yet (it stops at SPACE_BETWEEN), but
  // carried forward because an unknown key does not degrade to "leave it alone" —
  // it falls through to `start`, so an evenly-spaced row would silently import
  // left-packed. Cheap to accept, expensive to have shipped without.
  SPACE_EVENLY: "space-evenly"
};

const ALIGN: Record<string, AutoLayout["align"]> = { MIN: "start", CENTER: "center", MAX: "end" };
const ALIGN_SELF: Record<string, NonNullable<AutoLayout["align"]>> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  STRETCH: "stretch"
};
/**
 * A grid child's in-cell alignment → the DSL's `layoutAlignSelf`.
 *
 * Figma states this PER AXIS (`gridChildHorizontalAlign` and
 * `gridChildVerticalAlign`), and the DSL has ONE cross-axis field for a grid
 * child, so the two cannot always both be honoured. The horizontal axis wins —
 * it decides the offset a designer sees first — and the disagreement is reported
 * rather than resolved silently, because the one case it cannot express
 * ("centred horizontally, top-aligned vertically") costs a visible delta that
 * `verifyImport` would otherwise attribute to the track sizes.
 */
function gridChildAlign(node: FigmaNode, state: NodeWalkState): AutoLayout["align"] {
  const h = GRID_ALIGN[node.gridChildHorizontalAlign ?? ""];
  const v = GRID_ALIGN[node.gridChildVerticalAlign ?? ""];
  if (h && v && h !== v) gap(state, node, "grid:childAlign", `the DSL aligns a grid child on one axis; ${h}/${v} cannot both be kept`);
  return h ?? v;
}
const GRID_ALIGN: Record<string, NonNullable<AutoLayout["align"]>> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end"
};

const deg = (radians: number): number => (radians * 180) / Math.PI;

function normalizeDeg(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * Figma's own `rotation` field, read in the DOCUMENT's convention.
 *
 * The docs define it as `atan2(-m10, m00)` of `relativeTransform` — the NEGATIVE
 * of the angle that matrix turns through — because Figma measures
 * counter-clockwise while the DSL, like SVG's `rotate()`, measures clockwise on a
 * y-down canvas. It is the only source left when a response carries no transform,
 * and read raw it turns a layer the wrong way.
 */
function declaredRotationDeg(node: FigmaNode): number | undefined {
  return typeof node.rotation === "number" ? -node.rotation : undefined;
}

/**
 * A mirror, read off the transform's DETERMINANT.
 *
 * Figma writes a flip as a negative scale inside `relativeTransform` and gives the
 * layer no field of its own for it, so the matrix is the only place the mirror
 * exists. It is not in `rotation` either: that field is `atan2(-m10, m00)`, which
 * reports the same value for a mirrored layer as for the layer it mirrors, at
 * every angle (a matrix with a negative determinant reconstructs exactly from
 * `rotation` + a Y-flip alone — see `nodeRotationDeg`), so comparing the two
 * cannot find a mirror that the field never described. Doing it anyway is what
 * made a layer turned exactly a quarter turn — where the field and the matrix
 * disagree by the half turn of the comparison — arrive carrying a phantom flip,
 * with a rotation a half turn wrong for every reader that does not also apply it.
 *
 * `flipX` therefore never comes out of this door: `R(0)·flipX` and `R(180)·flipY`
 * are the same matrix, and the second is the one whose rotation is the angle the
 * layer is actually drawn at.
 *
 * A LINE takes none of this — mirroring a segment returns the same segment, so
 * `mapLine` absorbs the mirror into the angle instead. See `figmaLineRotation`.
 */
function figmaFlip(node: FigmaNode): { flipX: boolean; flipY: boolean } {
  const m = node.relativeTransform;
  if (!Array.isArray(m) || !Array.isArray(m[0]) || !Array.isArray(m[1])) return { flipX: false, flipY: false };
  const [a, b] = m[0];
  const [c, d] = m[1];
  if (![a, b, c, d].every((v) => typeof v === "number" && Number.isFinite(v))) {
    return { flipX: false, flipY: false };
  }
  return { flipX: false, flipY: a * d - b * c < 0 };
}

/**
 * An element's rotation in degrees.
 *
 * `relativeTransform` is the authoritative source for layer orientation: in screen
 * coordinates (Y down), column 0 `[a, c]` is where the layer's own x-axis points,
 * so `atan2(c, a)` is the angle the renderer's `rotate()` has to turn it through.
 * It is also exactly `-node.rotation`, mirrored layers included, so the matrix
 * never has to be reconciled with the field. When `relativeTransform` is absent,
 * fall back to `declaredRotationDeg`.
 */
function nodeRotationDeg(node: FigmaNode): number | undefined {
  const m = node.relativeTransform;
  if (Array.isArray(m) && Array.isArray(m[0]) && Array.isArray(m[1])) {
    const [a, b] = m[0];
    const [c, d] = m[1];
    if ([a, b, c, d].every((v) => typeof v === "number" && Number.isFinite(v))) {
      return deg(Math.atan2(c, a));
    }
  }
  return declaredRotationDeg(node);
}

/**
 * Figma's box is already absolute; zero-sized nodes mean the field is absent.
 */
const isRotated = (node: FigmaNode): boolean => {
  const rot = nodeRotationDeg(node);
  return typeof rot === "number" && Math.abs(((rot % 360) + 360) % 360) > 0.01;
};

/**
 * The node's own box, when the response carries one.
 *
 * `size` — sent only alongside `geometry=paths` — is the node's size BEFORE
 * rotation, which is the box a turned layer has to be given: `absoluteBoundingBox`
 * is the bound of the shape once rotated, so a 50×50 icon turned 45° reports
 * 70.7×70.7 and importing it at that size makes it a third too large.
 */
function ownSize(node: FigmaNode): { x: number; y: number } | null {
  const size = node.size;
  if (!size || typeof size.x !== "number" || typeof size.y !== "number") return null;
  if (size.x <= 0) return null;
  // A LINE's own height is legitimately 0 — the segment is horizontal in its own
  // space and every angle it is drawn at comes from `rotation`. Reading that as
  // "no size" is what made a rotated line import as the bound of its rotation.
  if (size.y <= 0 && node.type !== "LINE") return null;
  return size;
}

function hasGeometry(node: FigmaNode): boolean {
  const fill = node.fillGeometry?.[0]?.path;
  const stroke = node.strokeGeometry?.[0]?.path;
  return Boolean((fill && fill.length > 1) || (stroke && stroke.length > 1));
}

/**
 * What the walk knows about the node it is descending from.
 *
 * Two things the node's own fields cannot answer: whether its `x` / `y` are in a
 * space that will be drawn ROTATED, and which axis a bare `layoutGrow` grows
 * along.
 */
export interface ParentContext {
  /**
   * The parent's rotation will be drawn, so its children's canvas bounds are not
   * in the parent's own space.
   */
  rotated?: boolean;
  /** The parent's auto-layout mode, so a bare `layoutGrow` can be given an axis. */
  layoutMode?: string;
}

/** One node's box, and what the walk has to know about it afterwards. */
interface Placement {
  /** The element's box, in the space its `x` / `y` are measured in. */
  rect: Rect;
  /**
   * `rect` is already in the PARENT's own space, so the parent's canvas origin
   * must not be subtracted from it a second time.
   */
  local?: boolean;
  /** `rect` is the node's OWN box, so its children live in this node's space. */
  ownSpace: boolean;
  /** The rotation to draw. Only ever set when the box is the node's own. */
  rotation?: number;
}

/**
 * A rotated node's box and angle in its PARENT's own space, read off
 * `relativeTransform`.
 *
 * The canvas bound is in the wrong space here and cannot be converted into a
 * turned parent's: a box pushed back through a rotation is not the box that
 * produced it, so subtracting bounds lands the layer somewhere Figma never drew
 * it. `relativeTransform` IS the node's placement in exactly that parent space,
 * so the box, its angle and the spaces of everything below it fall out of it.
 *
 * The box is the node's OWN size and the point placed through the transform is
 * its CENTRE, because the transform turns a node about its own centre — which is
 * also the only one of its four corners the matrix's scale cannot move.
 */
function localPlacement(node: FigmaNode, size: { x: number; y: number } | null): Placement | null {
  const m = node.relativeTransform;
  if (!Array.isArray(m) || !Array.isArray(m[0]) || !Array.isArray(m[1])) return null;
  const [a, b, tx] = m[0];
  const [c, d, ty] = m[1];
  if (![a, b, c, d, tx, ty].every((v) => typeof v === "number" && Number.isFinite(v))) return null;

  const aabb = node.absoluteBoundingBox;
  const width = size?.x ?? aabb?.width ?? 0;
  const height = size?.y ?? aabb?.height ?? 0;
  if (!(width > 0) && !(height > 0)) return null;

  const centreX = tx + (a * width) / 2 + (b * height) / 2;
  const centreY = ty + (c * width) / 2 + (d * height) / 2;
  return {
    rect: { x: round2(centreX - width / 2), y: round2(centreY - height / 2), width: round2(width), height: round2(height) },
    local: true,
    ownSpace: true,
    rotation: round2(normalizeDeg(nodeRotationDeg(node) ?? deg(Math.atan2(c, a))))
  };
}

/**
 * Place one node, and say whether its own box (rather than a canvas bound) is
 * what came back.
 *
 * A container gets its own box for the same reason a leaf does: its
 * `absoluteBoundingBox` is the bound of the rotation, so a 100×100 frame turned
 * 45° reports 141×141 — and, before this, its rotation was dropped and its
 * children were laid out inside a box the frame never had. The rotation is now
 * carried and the children are placed in the frame's own space, so what Figma
 * drew is what the document holds.
 */
function placeNode(node: FigmaNode, parent: ParentContext | undefined, state: NodeWalkState): Placement | null {
  const aabb = node.absoluteBoundingBox;
  const size = ownSize(node);

  if (parent?.rotated) {
    const local = localPlacement(node, size);
    if (local) return local;
    // No transform to place it by, so the canvas bound is all there is — and it
    // is in another space. Named, because the alternative is a layer that looks
    // deliberate and is in the wrong place.
    gap(state, node, "rotation:relativeTransform", "the response carries no `relativeTransform`, so a layer inside a rotated frame is placed from its canvas bounds");
  }

  if (!aabb) return null;
  const bound = { x: aabb.x || 0, y: aabb.y || 0, width: aabb.width || 0, height: aabb.height || 0 };
  const own = size !== null && isRotated(node);
  const rect: Rect = own
    ? {
        x: round2(bound.x + (bound.width - size.x) / 2),
        y: round2(bound.y + (bound.height - size.y) / 2),
        width: size.x,
        height: size.y
      }
    : bound;

  // A vector whose geometry is empty reports a zero box, and a node with no box
  // and nothing to draw is not a layer: it is dropped and named instead.
  if (rect.width === 0 && rect.height === 0 && !hasGeometry(node)) return null;

  if (own) return { rect, ownSpace: true, rotation: round2(normalizeDeg(nodeRotationDeg(node) ?? 0)) };

  if (isRotated(node) && node.type !== "LINE") {
    // Turned, but the response carries no `size`, so there is no box to turn: the
    // bound is all there is and drawing the rotation on it would double the error
    // — the layer would be the bound of its rotation, turned again. A LINE is
    // exempt because it derives its own angle from the transform, with or without
    // a size, and names the loss it actually has (`line:direction`).
    gap(state, node, "node:rotation", "the response carries no `size` for this node, so there is no unrotated box to turn: the rotation is not drawn and the box stays the bound of it");
  }
  return { rect, ownSpace: false };
}

/**
 * Figma's auto-layout is the DSL's, so it maps field for field rather than
 * approximately — which is what keeps `verifyImport` from downgrading a
 * container that Figma itself laid out correctly.
 *
 * GRID is the third mode and has its own cell model, so it goes through
 * `mapFigmaGridLayout`: its tracks, gaps and placement are the DSL's grid
 * fields, and its per-track ratios are kept only where they reproduce Figma's
 * own rendered geometry. Mapping it onto the flex branch — which is what this
 * used to do by refusing to map it at all — produces a container that lays out
 * confidently and wrongly.
 */
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
  // Figma's `counterAxisSpacing` is the gap between WRAPPED lines, which is the
  // DSL's `rowGap` on a row layout and its `columnGap` on a column one.
  const crossGap = node.counterAxisSpacing;
  if (crossGap !== undefined) {
    if (direction === "row") layout.rowGap = crossGap;
    else layout.columnGap = crossGap;
  }
  return layout;
}

/**
 * Figma's sizing modes are the DSL's.
 *
 * A `layoutGrow` child fills its parent's PRIMARY axis — a row's width, a
 * column's height — and the axis is a property of the PARENT, which is why it is
 * passed in. The previous spelling guessed the axis from the child's own
 * `layoutSizingHorizontal`, and it read `FIXED` there as "so the grow must be
 * vertical": a row child that fills its width reported `FILL` (or, on the legacy
 * fields, nothing at all), so its `layoutSizingVertical: "HUG"` was overwritten
 * with `fill` and it stretched to the row's full height. `verifyImport` saw the
 * difference and downgraded the parent — correctly, one layer away from the
 * cause.
 *
 * Figma keeps `layoutGrow` and `layoutSizing*` in step, so the precise fields win
 * wherever they are present; the grow rule is only for a response that carries
 * the legacy field alone. A GRID child never grows (the matrix decides its cell),
 * so a grow on one is named rather than turned into an axis.
 */
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
    // Outside an auto-layout parent the field means nothing on Figma's side
    // either, so there is nothing to report and nothing to write.
  }

  // Explicit bounds. The DSL resolves these on every DERIVED size, which is what
  // makes an imported `max-width` keep meaning something after a drag instead of
  // being a fixed number — the same reason the HTML importer reads `max-width`
  // and the engine grew min/max support for it.
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

/**
 * A container that HUGS its content on an axis, stated by Figma on the container
 * rather than by `layoutSizing*` on the child.
 *
 * `counterAxisSizingMode: "AUTO"` is how a vertically-hugging frame is spelled —
 * it has no `layoutSizingVertical` of its own because it is not itself placed —
 * so without this a hug frame imports as a fixed-height box that stops hugging
 * the moment its text is edited.
 */
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

/**
 * Figma's constraints name an EDGE pair; the DSL names an axis mode.
 *
 * The API has spelled this two ways — `MIN`/`MAX`/`STRETCH` in older responses
 * and `TOP`/`BOTTOM`/`TOP_BOTTOM` (horizontal `LEFT`/`RIGHT`/`LEFT_RIGHT`) in the
 * current OpenAPI spec — so BOTH are accepted. A table with only one of them
 * matches nothing at all on the other, and the fallback is not "leave it alone":
 * an unmatched key means `resolveConstraints` sees no constraint and pins the
 * layer top-left, so every pinned-bottom layer imports pinned-top. That is worse
 * than the missing field it replaced, because it looks deliberate.
 */
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

const round2 = (n: number): number => Math.round(n * 100) / 100;

function gap(state: NodeWalkState, node: FigmaNode, property: string, value?: string): void {
  state.gaps.push({ id: node.id, name: node.name || node.type, property, value });
}

/** Bytes the node needs from the images endpoint, resolved before the walk. */
export function collectImageRef(node: FigmaNode, into: string[]): void {
  if (node.type !== "IMAGE") return;
  for (const fill of node.fills ?? []) {
    if (fill.type === "IMAGE" && typeof fill.imageRef === "string" && fill.imageRef) into.push(fill.imageRef);
  }
}

/**
 * A part-built element.
 *
 * The DSL's element union is closed per type — only a `FrameElement` has
 * `borderRadius`, only a `PathElement` has `d` — so an element that is still being
 * filled in cannot be typed as any member of it. It is built as a draft and cast
 * once, at the point its `type` is known and every field that type declares has
 * been set. Intersections are the alternative and they resolve to the NARROWEST
 * member, which is how a `borderRadius` write ends up typechecked as an instance.
 */
type Draft = Record<string, unknown> & { id: string; x: number; y: number; width: number; height: number };

function base(node: FigmaNode, rect: Rect, parentX: number, parentY: number): Draft {
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
  // A line takes its flip as an angle instead — see `figmaLineRotation` — so it
  // is the one type that must not also be given the mirror flags.
  if (node.type !== "LINE") {
    const flip = figmaFlip(node);
    if (flip.flipX) out.flipX = true;
    if (flip.flipY) out.flipY = true;
  }
  // `isMask`, not `mask`: the short name matches nothing in a real response, so
  // every mask layer would have imported as an ordinary one.
  if (node.isMask) out.isMask = true;
  const maskMode = MASK_MODES[node.maskType ?? ""];
  if (maskMode) out.maskMode = maskMode;
  return out;
}

const MASK_MODES: Record<string, DesignElement["maskMode"]> = {
  ALPHA: "alpha",
  LUMINANCE: "luminance"
};

/**
 * The angle a line is drawn at, read off the transform rather than off
 * `rotation`.
 *
 * A segment mirrored about its own midpoint IS the same segment, so a LINE
 * cannot carry a flip the way every other shape does — `flipY` on a level line
 * is a no-op, and negating `dx` instead would move the renderer's rotation pivot
 * (it reads `x + width / 2`, which is only the midpoint while `dx ≥ 0`). The
 * flip therefore has to be absorbed into the angle, and the angle is derived by
 * pushing the node's OWN box diagonal through the transform: the direction the
 * local segment `(0,0) → (size)` points in the parent, minus the direction it
 * points in its own space.
 *
 * With no flip the two differ by exactly the angle the matrix turns through, so
 * this is the transform read once more and never a second guess at the layer's
 * direction.
 */
function figmaLineRotation(node: FigmaNode): number | undefined {
  const size = node.size;
  const m = node.relativeTransform;
  if (!size || size.x <= 0 || !Array.isArray(m) || !Array.isArray(m[0]) || !Array.isArray(m[1])) {
    return declaredRotationDeg(node);
  }
  const [a, b] = m[0];
  const [c, d] = m[1];
  if (![a, b, c, d].every((v) => typeof v === "number" && Number.isFinite(v))) {
    return declaredRotationDeg(node);
  }
  const worldX = a * size.x + b * size.y;
  const worldY = c * size.x + d * size.y;
  if (worldX === 0 && worldY === 0) return declaredRotationDeg(node);
  return deg(Math.atan2(worldY, worldX) - Math.atan2(size.y, size.x));
}

/**
 * Why one unmapped paint did not carry across.
 *
 * Absent for a kind whose DSL spelling simply does not exist — naming the type is
 * the whole of what can be said about it. A video fill is the one worth a
 * sentence: it is not a gap in this mapper but a limit of the plugin API, and
 * without the sentence the layer reads as an empty rectangle nobody can account
 * for.
 */
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
  // An image fill is a LOOKUP, not a value: its bytes were fetched before this
  // walk, so this only ever asks whether they arrived.
  const resolve = (ref: string) => state.images?.idFor(ref);
  // Placing a paint needs two sizes: the box it is placed in — which is also the
  // space a conic's sweep angle is measured in — and, when the paint is a bitmap,
  // the bitmap's own. Both are read from what the document will carry — `base`
  // already wrote the box, and the asset record is the same one the renderer
  // reads back — so the framing solved here cannot disagree with the framing
  // painted.
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
  // In Figma, BACKGROUND_BLUR is gated by the layer's own visible fill; a
  // fill-less container with a dormant BACKGROUND_BLUR effect renders no
  // backdrop blur over its bounding box.
  const activeEffects = hasVisiblePaint(node.fills)
    ? node.effects
    : node.effects?.filter((e) => e.type !== "BACKGROUND_BLUR");
  const effects = mapFigmaEffects(activeEffects);
  if (effects) out.effects = effects;

  // Anything still here did not carry across — most often an image whose bytes
  // never arrived, or a paint kind the DSL has no name for. Named, never dropped.
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
      // TILE has no DSL spelling at all; a CROP whose transform could not be
      // written down — squashed along one axis, mirrored, or with a bitmap size
      // nothing recorded — is the other. Each falls back to a cover and is named.
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
    // A turned bitmap keeps the plain cover when the box or the image's size is
    // missing, which lands it a quarter turn out — the one degradation of this
    // mapping that no geometric check can see, so it is named.
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
    // An effect whose blend mode cannot be mapped is dropped by `mapFigmaEffects`
    // and reported here as an unmapped gap.
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

/**
 * The effect kinds `mapFigmaEffects` reads. Kept beside the reporting loop so
 * adding one there and forgetting it here — which is what made glass report
 * itself as unmapped while the app was quietly dropping it — is a diff rather
 * than a bug.
 */
const MAPPED_EFFECTS = new Set(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR", "GLASS"]);

function mapLine(node: FigmaNode, rect: Rect, parentX: number, parentY: number, state: NodeWalkState, ownSpace: boolean): Draft {
  const out = base(node, rect, parentX, parentY);
  out.type = "line";
  // `dx`/`dy` are the SEGMENT and `rotation` is what turns it — the same pair the
  // renderer uses. They are the segment only when the box is the node's own size,
  // which is why a LINE is one of the types `placeNode` re-expresses that way.
  //
  // Off the AABB they are the bound of the rotated segment instead: the two
  // endpoints are only recoverable when it is corner-to-corner, so it draws —
  // along the OTHER diagonal — and that is recorded rather than guessed. A
  // export captured without `size` still hits this, which is why the gap survives
  // next to the fix.
  out.dx = round2(rect.width);
  out.dy = round2(rect.height);
  if (!ownSpace && rect.width !== 0 && rect.height !== 0) {
    gap(state, node, "line:direction", "the line is rotated and the response carries no `size`, so its direction is assumed top-left to bottom-right");
  }
  const rotation = figmaLineRotation(node);
  if (typeof rotation === "number" && Math.abs(rotation) > 0.01) out.rotation = round2(rotation);
  const strokes = mapFigmaStrokes(node);
  if (strokes) Object.assign(out, strokes);
  else out.strokes = [{ color: "#000000", width: 1, enabled: true }];
  return out;
}

/**
 * A vector's geometry, mapped straight onto the DSL's `path.d`.
 *
 * NO translation. Figma's `fillGeometry` / `strokeGeometry` are "paths
 * representing the object fill **relative to the node**" — the same local space
 * `size` measures and `relativeTransform` exists to map out of — and the DSL
 * draws `d` inside a `translate(x, y)` of the element's own box, which is the
 * same origin. Moving the path by anything at all puts every vector off by that
 * much; the earlier version moved it by the node's PARENT-relative offset, so
 * even the sign of the error depended on how deep in the tree the icon sat.
 *
 * The raw string is kept rather than round-tripped through the engine's path
 * model, because that model is cubic-only and a `d` it cannot represent would be
 * emptied into an invisible shape; the renderer emits `d` verbatim, so verbatim
 * is the faithful thing to store.
 */
function mapVector(node: FigmaNode, rect: Rect, parentX: number, parentY: number, state: NodeWalkState): Draft {
  const out = base(node, rect, parentX, parentY);
  out.type = "path";
  // Which geometry is "the drawing" depends on which paint is visible, because
  // the two geometry arrays describe different things. For a FILLED vector
  // `fillGeometry` is the fill region. For an outline icon — strokes and no
  // visible fill, the shape of every line-art glyph in a real file —
  // `fillGeometry` is not empty but degenerate (Figma writes a sliver there) and
  // the artwork lives in `strokeGeometry`, already expanded to a region. Taking
  // `fillGeometry` whenever it exists collapsed those icons to the sliver.
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
    // The geometry above IS the stroke, already expanded — stroking it as well
    // would draw a second outline around the first stroke's edge. Paint it as a
    // fill with the stroke's own paint instead.
    delete out.strokes;
    const asFills = mapFigmaStrokeAsFills(node, { width: rect.width, height: rect.height });
    if (asFills) out.fills = asFills;
  }
  return out;
}

/** Does the node carry any paint of this kind that would actually draw? */
function hasVisiblePaint(paints: FigmaPaint[] | undefined): boolean {
  return Array.isArray(paints) && paints.some((p) => !!p && p.visible !== false && !!p.type);
}

/**
 * Write the rotation, for any element whose box is its own.
 *
 * The DSL turns an element about its box centre — where Figma reports the bound
 * from — so this is exact for a leaf and, now, for a container: `placeNode` gives
 * a turned frame its own box and its children are placed in that frame's own
 * space, so the frame turns and everything inside turns with it. A container's
 * rotation used to be refused and merely reported, which left a turned frame
 * flat and its contents laid out in the bound of its rotation.
 *
 * The angle comes from the placement rather than from `node.rotation` because
 * `node.rotation` states the node's turn in its own parent's terms — inside a
 * turned frame the transform angle is the one that fits the space the element is
 * being drawn in.
 */
function carryRotation(out: Draft, rotation: number | undefined): void {
  // A line derives its own angle from the transform, flip included; writing the
  // node's plain `rotation` over it would throw the flip away again.
  if (out.rotation !== undefined || rotation === undefined) return;
  const angle = normalizeDeg(rotation);
  if (Math.abs(angle) > 0.01) out.rotation = round2(angle);
}

function mapContainer(node: FigmaNode, rect: Rect, parentX: number, parentY: number, state: NodeWalkState, kind: "frame" | "component" | "componentSet"): Draft {
  const out = base(node, rect, parentX, parentY);
  out.type = kind;
  out.children = [];
  out.clipContent = node.clipsContent ?? false;
  const radius = mapFigmaCornerRadius(node);
  if (radius !== undefined) out.borderRadius = radius;
  if (typeof node.cornerSmoothing === "number" && node.cornerSmoothing > 0) out.cornerSmoothing = node.cornerSmoothing;
  paintOf(node, out, state);
  const layout = mapFigmaAutoLayout(node, state);
  if (layout) Object.assign(out, flattenLayout(layout));

  if (node.type === "INSTANCE") {
    out.metadata = { figmaComponentId: sanitizeElementId(node.componentId ?? "") };
  }
  return out;
}

/**
 * Map one Figma node and, recursively, its children.
 *
 * Returns `null` for a node that produces nothing (a hidden node, an unknown
 * leaf with no geometry, a node past `maxElements`), and the caller simply does
 * not attach it — so a dropped subtree costs the caller nothing and is reported
 * through `state.gaps` rather than by going quietly missing.
 *
 * `parentX` / `parentY` are the parent's box origin, in CANVAS space, and are
 * only used while the parent's own space is the canvas's — `parent.rotated` says
 * when it is not, and then each child's box comes from its own
 * `relativeTransform` instead.
 */
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

  const placed = placeNode(node, parent, state);
  if (!placed) {
    if (node.type !== "DOCUMENT" && node.type !== "CANVAS") gap(state, node, "node:noBounds", node.type);
    return null;
  }
  const rect = placed.rect;
  // A box that already IS in the parent's own space takes no origin subtraction.
  const originX = placed.local ? 0 : parentX;
  const originY = placed.local ? 0 : parentY;

  const id = sanitizeElementId(node.id);
  let out: Draft | null = null;

  switch (node.type) {
    case "FRAME":
    case "GROUP":
    case "SECTION":
    case "INSTANCE":
    case "BRUSH":
    case "SLICE":
      out = mapContainer(node, rect, originX, originY, state, "frame");
      break;
    // A Figma SLIDE is a `BaseFrameMixin` — a frame that also carries a
    // transition and speaker notes. It is imported as the frame it is, and the
    // app's presentation reads one top-level container per slide, so a deck
    // arrives as a deck. Without this case it would fall through to `default`,
    // be built as a frame anyway, and ALSO be reported as an unknown node type.
    //
    // Figma hangs the transition on the slide it leaves, which is exactly where
    // the DSL keeps it, so it lands on this element without a hand-off.
    case "SLIDE": {
      out = mapContainer(node, rect, originX, originY, state, "frame");
      const slide = mapFigmaSlideTransition(node.slideTransition);
      if (slide.spec) out.slide = slide.spec;
      for (const note of slide.gaps) gap(state, node, note.property, note.value);
      break;
    }
    case "COMPONENT":
      out = mapContainer(node, rect, originX, originY, state, "component");
      break;
    case "COMPONENT_SET":
      out = mapContainer(node, rect, originX, originY, state, "componentSet");
      break;
    case "TEXT":
      out = fillTextElement(base(node, rect, originX, originY), node, state);
      paintOf(node, out, state);
      // A Figma TEXT with no fill at all is a layer whose glyphs are invisible —
      // an outline-only label whose stroke carries the shape, or a layer the
      // designer hid. The DSL reads text paint from `fills` ALONE, so the
      // decision has to be written down: leaving the key off hands the colour to
      // `style.color`, whose default is opaque black (LESSONS_LEARNED §206).
      if (out.fills === undefined) out.fills = [];
      break;
    case "RECTANGLE": {
      // A rectangle is not a container: it carries the frame's paint and radius
      // but none of its layout or clipping fields, so it is built from `base`
      // rather than by demoting a frame.
      const rectEl = base(node, rect, originX, originY);
      rectEl.type = "rect";
      const radius = mapFigmaCornerRadius(node);
      if (radius !== undefined) rectEl.borderRadius = radius;
      if (typeof node.cornerSmoothing === "number" && node.cornerSmoothing > 0) rectEl.cornerSmoothing = node.cornerSmoothing;
      paintOf(node, rectEl, state);
      out = rectEl;
      break;
    }
    case "ELLIPSE": {
      const ellipse = base(node, rect, originX, originY);
      ellipse.type = "ellipse";
      paintOf(node, ellipse, state);
      out = ellipse;
      break;
    }
    case "LINE":
      out = mapLine(node, rect, originX, originY, state, placed.ownSpace);
      break;
    case "VECTOR":
    case "BOOLEAN_OPERATION":
    case "STAR":
    case "REGULAR_POLYGON":
      out = mapVector(node, rect, originX, originY, state);
      break;
    case "STAR_POLYGON":
      out = mapVector(node, rect, originX, originY, state);
      break;
    // The plugin's name for a regular polygon. The shim renames it on the way out
    // (as it renames `data` to `path`), so a file that has been through this
    // importer's plugin door never carries it — but an export captured before
    // that rename does, and it was arriving as an unknown node type and being
    // dropped with its whole page rather than imported as the polygon it is.
    case "POLYGON":
      out = mapVector(node, rect, originX, originY, state);
      break;
    case "IMAGE":
      out = mapImage(node, rect, originX, originY, state);
      break;
    default:
      if (node.children?.length) {
        out = mapContainer(node, rect, originX, originY, state, "frame");
        gap(state, node, `node:type:${node.type}`);
      } else {
        gap(state, node, `node:type:${node.type}`);
        return null;
      }
  }

  if (!out) return null;

  // An ALPHA or LUMINANCE leaf mask with no visible fill or stroke paints zero
  // alpha in Figma and hides the siblings it masks, whereas leaving `fills`
  // undefined would fall back to the outline stencil (`#FFFFFF` at 100% alpha).
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
  // A grid child carries its own cell (0-based anchors / spans become the DSL's
  // 1-based `layoutCell`) and its own in-cell alignment. Both are read here,
  // independently of the container: a flex frame's children have neither, so a
  // plain node leaves this a no-op.
  const cell = mapFigmaGridChild(node);
  if (cell?.layoutCell) out["grid-area"] = cell.layoutCell;
  const gridAlign = gridChildAlign(node, state);
  if (gridAlign && !alignSelf) out["align-self"] = toCssLine(gridAlign);

  state.elementCount += 1;
  state.measured.set(id, rect);
  if (!state.usedIds.has(id)) state.usedIds.add(id);

  // `placed.ownSpace` is what tells the children which space they are in: a node
  // whose box is its OWN is drawn turned, so its children's canvas bounds are in
  // a space that no longer lines up with it and each of them is placed from its
  // own `relativeTransform` instead. A `BOOLEAN_OPERATION` already flattened its
  // operands into `fillGeometry`, so its children are not separate layers.
  const children =
    node.type === "BOOLEAN_OPERATION"
      ? []
      : (node.children ?? [])
          .map((child) => mapFigmaNode(child, rect.x, rect.y, state, { rotated: placed.ownSpace, layoutMode: node.layoutMode }))
          .filter((c): c is DesignElement => c !== null);
  if (children.length > 0) {
    // A frame holds boxes and a text holds runs; neither holds both. A node with
    // children that is not a container keeps its own geometry and reports the
    // subtree it could not carry rather than flattening it and losing the boxes.
    if (out.type === "frame" || out.type === "component" || out.type === "componentSet") {
      out.children = children;
    } else {
      gap(state, node, "node:mixedContent", node.type);
    }
  }
  return out as unknown as DesignElement;
}

/**
 * A bare `IMAGE` node.
 *
 * The DSL has no "image node" type — a picture is a box with an image fill, which
 * is exactly what the HTML importer produces for `<img>` — so this is a `rect`.
 * It used to return the bare base with no `type` at all, which `normalize` then
 * had to guess at: an element with no type is not an image, it is a malformed
 * one, and it is what a caller sees when every photo in a file goes missing.
 */
function mapImage(node: FigmaNode, rect: Rect, parentX: number, parentY: number, state: NodeWalkState): Draft {
  const out = base(node, rect, parentX, parentY);
  out.type = "rect";
  const radius = mapFigmaCornerRadius(node);
  if (radius !== undefined) out.borderRadius = radius;
  paintOf(node, out, state);
  return out;
}

export type { Draft };
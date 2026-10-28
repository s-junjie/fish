import { DesignDocument, DesignElement, ImagePaint, Paint } from "../../core/dsl/types";
import { elementPivot, elementTransform, getRotateCursor } from "../../core/geometry/transforms";
import { worldOriginOf } from "../../core/interactions/component-swap";
import {
  CropCorner,
  CropHandle,
  CropPlacement,
  assetNaturalSize,
  cropCorners,
  cropFramePoints,
  cropRotateZones,
  imageCropPlacement
} from "../../core/geometry/image-crop";
import { ImagePaintImage, imagePaintImage } from "./image-paint-attrs";
import {
  CANVAS_CROP_DIM,
  CANVAS_GUIDE,
  CANVAS_ON_SELECT,
  CANVAS_SELECT,
  withAlpha
} from "./canvas-colors";

export interface ImageCropOverlayProps {
  doc: DesignDocument;
  /** The layer being cropped — already resolved from the store's target. */
  el: DesignElement;
  /** Which of the layer's fills is the bitmap in crop mode. */
  paintIndex: number;
  zoom: number;
  onMovePointerDown: (e: PointerEvent, el: DesignElement, paintIndex: number) => void;
  /** Any of the frame's eight handles — corners and edge midpoints alike. */
  onHandlePointerDown: (e: PointerEvent, el: DesignElement, paintIndex: number, handle: CropHandle) => void;
  onRotatePointerDown?: (
    e: PointerEvent,
    el: DesignElement,
    paintIndex: number,
    corner: CropCorner,
    baseAngle: number
  ) => void;
}

/**
 * The handle cursors, spelled exactly as the transform box spells them: the
 * frame's handles ARE the transform box's handles, so an arrow that meant one
 * thing there must not mean another here.
 */
const HANDLE_CURSOR: Record<CropHandle, string> = {
  nw: "nwse-resize",
  ne: "nesw-resize",
  se: "nwse-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  w: "ew-resize",
  e: "ew-resize"
};

/**
 * Where each handle's mark runs from the frame point, as a unit direction.
 *
 * A corner's two arms and an edge's one bar are the same table: the corner runs
 * along both its edges, the edge along one axis. Photoshop draws its crop box
 * this way — thick brackets on the corners, thick bars on the middles — and the
 * shape is what tells you the gesture: a bracket is two axes, a bar is one.
 */
const HANDLE_DIR: Record<CropHandle, { x: 0 | 1 | -1; y: 0 | 1 | -1 }> = {
  nw: { x: 1, y: 1 },
  ne: { x: -1, y: 1 },
  se: { x: -1, y: -1 },
  sw: { x: 1, y: -1 },
  n: { x: 1, y: 0 },
  s: { x: 1, y: 0 },
  e: { x: 0, y: 1 },
  w: { x: 0, y: 1 }
};

/**
 * The ink a handle is drawn in: the transform box's own two colours, spelled
 * once, so the thing you drag here is recognisably the thing you drag there. The
 * rim is also what makes a white mark legible on a white picture — without it,
 * white-on-white would be a hole rather than a handle.
 */
const HANDLE_RIM = 1.5;

/**
 * A handle's bar thickness, in screen px, and how far a mark runs from the
 * frame point — a corner's arms along their edges, an edge's bar each way.
 *
 * Screen px because a handle is an affordance, not artwork: it has to stay the
 * same size in the hand whatever the zoom.
 */
const HANDLE_THICK = 4;
const CORNER_ARM = 14;
const EDGE_BAR = 10;

/**
 * The invisible grab radius on every handle.
 *
 * Larger than the mark it sits on, because the mark is a 4px stroke and a 4px
 * target is a miss. This is the number the rotate zones below are placed
 * against, so moving it is not a cosmetic change.
 */
const GRAB_R = 12;

/**
 * The rotate zone: a circle just outside a corner whose CURSOR is the whole
 * affordance, exactly as on the transform box.
 *
 * 18 rather than the transform box's 14, because this overlay's handles carry a
 * `GRAB_R` circle that the transform box's small square does not. The zone's
 * nearest point is `GAP·√2 − R` = 25.5 − 10 = 15.5px out from the corner, clear
 * of the 12px grab, so neither gesture can ever eat the other's press — the
 * inequality is `GAP·√2 > GRAB_R + ROTATE_ZONE_R`, and tightening any of the
 * three past it silently steals the corner's outer edge.
 */
const ROTATE_ZONE_R = 10;
const ROTATE_ZONE_GAP = 18;

/**
 * The scrim's strength. Heavy enough to separate the two regions, light enough
 * that the cropped-away pixels are still legible as the image they are.
 */
const CROP_DIM_ALPHA = 0.4;

/**
 * The bitmap's placement for one of an element's fill rows, or null when there
 * is nothing to draw chrome around.
 *
 * Every caller asks the same questions — is this row an image, does the document
 * know the bitmap's natural size, and where does the framing land — and a second
 * copy of that question is how the overlay and the renderer drift apart. The
 * `<image>` comes back with it for the same reason: the bitmap the overlay draws
 * outside the frame has to be the bitmap the tile paints inside it, attribute
 * for attribute, and `imagePaintImage` is the only thing that decides those.
 */
export function cropPlacementOf(
  doc: DesignDocument,
  el: DesignElement,
  paintIndex: number
): { paint: ImagePaint; placement: CropPlacement; image: ImagePaintImage } | null {
  const paint = (el.fills ?? [])[paintIndex] as Paint | undefined;
  if (!paint || paint.type !== "image") return null;
  if (paint.fit !== "crop" || !paint.crop) return null;
  const asset = (doc.assets ?? []).find((a) => a.id === paint.assetId);
  const natural = assetNaturalSize(asset);
  if (!asset || !natural) return null;
  const box = { width: el.width, height: el.height };
  const placement = imageCropPlacement(box, natural, paint.crop);
  const image = imagePaintImage(paint, box, asset);
  if (!placement || !image) return null;
  return { paint: paint as ImagePaint, placement, image };
}

/**
 * Crop mode's on-canvas chrome: the frame, the bitmap overflowing it, the eight
 * handles on that frame, and the four hot zones that turn the bitmap.
 *
 * The model is a WINDOW, not a bitmap transform. The frame is the element's own
 * box and the handles resize it; the bitmap stays exactly where it is on the
 * canvas, so pulling an edge across reveals or hides pixels and a crop reads as
 * a crop rather than as a scale. That is why the handles sit on the box's own
 * corners and edge midpoints — the transform box's own set, in the transform
 * box's own places — and why the bitmap's outline is drawn as a REFERENCE with
 * no handles of its own: it is what the window is aimed at, and it is allowed to
 * be a long way outside.
 *
 * It stands in for the transform box for the duration, exactly as the gradient
 * lever does — Figma parity — which is why `SelectionOverlay` drops its own box
 * while this is up. What differs is only what a drag writes: the frame drag
 * re-solves the fill's `crop` so the bitmap does not move, and a body drag moves
 * the bitmap under the window.
 *
 * Everything is drawn inside the element's own transform `<g>`, so the
 * coordinates are the same unrotated root space `SelectionOverlay` uses and the
 * element's rotation carries the chrome along with the artwork.
 */
export function ImageCropOverlay({
  doc,
  el,
  paintIndex,
  zoom,
  onMovePointerDown,
  onHandlePointerDown,
  onRotatePointerDown
}: ImageCropOverlayProps) {
  const resolved = cropPlacementOf(doc, el, paintIndex);
  if (!resolved) return null;
  const { placement, image } = resolved;

  const origin = worldOriginOf(doc, el);
  const worldX = origin.x + el.x;
  const worldY = origin.y + el.y;
  const pivot = elementPivot(el);
  const cx = worldX + pivot.x - el.x;
  const cy = worldY + pivot.y - el.y;
  const rot = el.rotation || 0;

  const box = { width: el.width, height: el.height };
  // Screen-px weights carried into user units. `rim` is the transform box's own
  // outline weight, which is why the frame line and the handle rims match it.
  const rim = HANDLE_RIM / zoom;
  const handles = cropFramePoints(box).map((h) => ({
    id: h.id,
    x: h.x + worldX,
    y: h.y + worldY,
    cursor: HANDLE_CURSOR[h.id]
  }));
  const zones = cropRotateZones(box, ROTATE_ZONE_GAP / zoom).map((z) => ({
    id: z.id,
    angle: z.angle,
    x: z.x + worldX,
    y: z.y + worldY
  }));

  // The bitmap is drawn from its own placement, which is a different rect from
  // the frame whenever the framing is not exactly `cover`.
  const bitmap = cropCorners(placement).map((c) => ({ id: c.id, x: c.x + worldX, y: c.y + worldY }));
  const bitmapCenter = { x: placement.centerX + worldX, y: placement.centerY + worldY };

  // ONE region, named once: the bitmap MINUS the frame. It is the clip that
  // leaves the bitmap visible only where the tile is not already painting it,
  // and the scrim's own outline.
  //
  // Its two halves are the two things the model promises: the frame's interior
  // is knocked out because the tile paints it at full strength, and the part of
  // the frame that falls OUTSIDE the bitmap is knocked out too — the frame is a
  // window and may be dragged past the picture, and a scrim over ground the
  // element does not cover is the one region this chrome is not about.
  const quadPath = bitmap.map((c, i) => `${i === 0 ? "M" : "L"}${c.x} ${c.y}`).join("") + "Z";
  const framePath = `M${worldX} ${worldY}H${worldX + el.width}V${worldY + el.height}H${worldX}Z`;
  const outsidePath = `${quadPath}${framePath}`;
  const outsideClipId = `image_crop_outside_${el.id}`;

  return (
    <g data-overlay="true" data-image-crop-overlay="1" transform={elementTransform(el, cx, cy)}>
      <clipPath id={outsideClipId} clipPathUnits="userSpaceOnUse">
        <path d={outsidePath} clipRule="evenodd" />
      </clipPath>

      {/* The bitmap's own pixels, outside the frame, under the scrim.
          Without this the cropped-away part is a flat grey — the tile clipped
          the bitmap away and the scrim is all that is left of it — so "what am I
          cutting off?" can only be answered by dragging the edge back. Drawn
          from `image` rather than from the placement so it IS the same picture
          the tile paints, and clipped rather than masked: a mask allocates a
          surface the size of its region, and a framing is free to sit thousands
          of boxes away from the frame it belongs to. */}
      <g data-image-crop-outside="1" clipPath={`url(#${outsideClipId})`} pointerEvents="none">
        <g transform={`translate(${worldX} ${worldY})`}>
          <image {...image} />
        </g>
      </g>

      {/* The scrim, over that. It doubles as the OUTSIDE grab surface: the
          frame's own interior is served by the rect further down, and between
          them the whole bitmap is draggable — which is what makes "drag the
          image anywhere" true even once it has been pulled well out of frame.
          The fill rule is redundant beside the clip and kept anyway, so the
          surface the pointer catches is the shape that is drawn rather than
          whatever the browser chooses to hit-test through a clip. */}
      <path
        data-image-crop-dim="1"
        d={outsidePath}
        fillRule="evenodd"
        fill={withAlpha(CANVAS_CROP_DIM, CROP_DIM_ALPHA)}
        clipPath={`url(#${outsideClipId})`}
        style={{ cursor: "move" }}
        onPointerDown={(e) => onMovePointerDown(e as any, el, paintIndex)}
      />

      <rect
        data-image-crop-bitmap="1"
        x={bitmapCenter.x - placement.width / 2}
        y={bitmapCenter.y - placement.height / 2}
        width={placement.width}
        height={placement.height}
        fill="none"
        stroke={CANVAS_SELECT}
        strokeWidth={1 / zoom}
        opacity={0.5}
        pointerEvents="none"
        transform={
          placement.rotation ? `rotate(${placement.rotation} ${bitmapCenter.x} ${bitmapCenter.y})` : undefined
        }
      />

      <rect
        data-image-crop-frame="1"
        x={worldX}
        y={worldY}
        width={el.width}
        height={el.height}
        fill="none"
        stroke={CANVAS_GUIDE}
        strokeWidth={rim}
        strokeDasharray={`${4 / zoom} ${3 / zoom}`}
        pointerEvents="none"
      />

      <rect
        data-image-crop-move="1"
        x={worldX}
        y={worldY}
        width={el.width}
        height={el.height}
        fill="transparent"
        style={{ cursor: "move" }}
        onPointerDown={(e) => onMovePointerDown(e as any, el, paintIndex)}
      />

      {/* The handles, Photoshop's way: an L bracket on each corner, a bar on
          each edge midpoint, both straddling the frame line so the mark covers
          the boundary rather than sitting on one side of it. Two passes —
          the rim, then the mark — drawing the transform box's own pair of
          colours, which is what the resize handles one mode earlier are: white
          ink in a blue rim. `square` caps are what close that rim around the
          ends of the mark; with butt caps the ends would be bare white.

          Handles before the rotate zones: the zones are the finer target and
          must win wherever a corner's grab circle could reach one, which is why
          the gap above is chosen so that they never actually meet. */}
      {handles.map(({ id, x, y, cursor }) => {
        const dir = HANDLE_DIR[id];
        const corner = dir.x !== 0 && dir.y !== 0;
        const reach = (corner ? CORNER_ARM : EDGE_BAR) / zoom;
        const d = corner
          ? `M${dir.x * reach} 0H0V${dir.y * reach}`
          : dir.x
            ? `M${-reach} 0H${reach}`
            : `M0 ${-reach}V${reach}`;
        const thick = HANDLE_THICK / zoom;
        return (
          <g
            key={id}
            data-image-crop-handle={id}
            transform={`translate(${x} ${y})`}
            style={{ cursor }}
            onPointerDown={(e) => onHandlePointerDown(e as any, el, paintIndex, id)}
          >
            <circle r={GRAB_R / zoom} fill="transparent" />
            <path
              d={d}
              fill="none"
              stroke={CANVAS_SELECT}
              strokeWidth={thick + 2 * rim}
              strokeLinecap="square"
              strokeLinejoin="miter"
              pointerEvents="none"
            />
            <path
              d={d}
              fill="none"
              stroke={CANVAS_ON_SELECT}
              strokeWidth={thick}
              strokeLinecap="square"
              strokeLinejoin="miter"
              pointerEvents="none"
            />
          </g>
        );
      })}

      {/* Rotation, the canvas's way: an invisible zone just outside each corner.
          There is no grip and no leader line — a second, differently-placed
          handle for the same idea is one affordance too many, and the cursor is
          what announces this one, exactly as it does on the transform box. The
          angle carries the element's own rotation the way the transform box's
          zones do, so the arrow points along the edge the pointer is next to. */}
      {onRotatePointerDown &&
        zones.map(({ id, x, y, angle }) => (
          <circle
            key={`rotate_${id}`}
            data-image-crop-rotate={id}
            cx={x}
            cy={y}
            r={ROTATE_ZONE_R / zoom}
            fill="transparent"
            style={{ cursor: getRotateCursor(rot + angle) }}
            onPointerDown={(e) => onRotatePointerDown(e as any, el, paintIndex, id, angle)}
          />
        ))}
    </g>
  );
}

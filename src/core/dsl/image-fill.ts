import { createId } from "../id";
import type { ColorFilter, DesignElement, Paint, PaintStack } from "./types";

export type ImagePaint = Extract<Paint, { type: "image" }>;

export interface ImageFillSpec {
  id?: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  assetId: string;
  fit?: ImagePaint["fit"];
  focalPoint?: { x: number; y: number };
  adjust?: ColorFilter;
}

export function imageFillPaint(spec: ImageFillSpec): ImagePaint {
  return {
    type: "image",
    assetId: spec.assetId,
    fit: spec.fit ?? "cover",
    ...(spec.focalPoint ? { focalPoint: spec.focalPoint } : {}),
    ...(spec.adjust ? { adjust: spec.adjust } : {})
  };
}

export function createImageFillElement(spec: ImageFillSpec): DesignElement {
  return {
    id: spec.id ?? createId("image"),
    type: "rect",
    ...(spec.name ? { name: spec.name } : {}),
    x: Math.round(spec.x),
    y: Math.round(spec.y),
    width: Math.round(spec.width),
    height: Math.round(spec.height),
    fillEnabled: true,
    fills: [imageFillPaint(spec)],
    constraints: { preserveAspectRatio: true }
  };
}

/** Every paint layer an element owns. */
export function paintLayers(el: { fills?: PaintStack }): Paint[] {
  return el.fills ? el.fills.slice() : [];
}

/** The first image layer of an element, which is what the edit panel edits. */
export function firstImagePaint(el: { fills?: PaintStack }): ImagePaint | undefined {
  return paintLayers(el).find((p): p is ImagePaint => p.type === "image");
}

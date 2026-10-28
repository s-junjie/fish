import { useEffect, useState } from "preact/hooks";
import type { DesignDocument, ImagePaint, Paint } from "../../core/dsl/types";
import { cropFromFraming, assetNaturalSize } from "../../core/geometry/image-crop";
import { measureNaturalSize } from "../../core/interactions/image-loader";
import { findNodeById } from "../../core/interactions/component-swap";
import { writeNodeEdit } from "../../core/interactions/instance-overrides";
import { t } from "../../i18n";

/**
 * Which image layer is in crop mode.
 *
 * A module store rather than prop threading, exactly like `gradient-edit`: it is
 * written in the inspector (the fill row's Crop segment) and read on the canvas
 * (the crop overlay, and the selection box standing down), and those two are at
 * opposite ends of the tree. Null = no layer is being cropped.
 */
export interface ImageCropTarget {
  elId: string;
  paintIndex: number;
}

let target: ImageCropTarget | null = null;
const listeners = new Set<() => void>();

export function setImageCropTarget(next: ImageCropTarget | null) {
  const same =
    target === next ||
    (target && next && target.elId === next.elId && target.paintIndex === next.paintIndex);
  if (same) return;
  target = next;
  listeners.forEach((fn) => fn());
}

export function getImageCropTarget(): ImageCropTarget | null {
  return target;
}

export function useImageCropTarget(): ImageCropTarget | null {
  const [cur, setCur] = useState<ImageCropTarget | null>(target);
  useEffect(() => {
    const fn = () => setCur(target);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return cur;
}

export interface BeginImageCropDeps {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  target: ImageCropTarget;
  hint?: (message: string) => void;
}

/**
 * The way into crop mode that COSTS an edit — the fill row's Crop segment and
 * the context menu land here. Re-entering the mode over a framing the document
 * already carries does not: that is `setImageCropTarget` alone, in
 * `useCanvasGestures`.
 *
 * Entering commits `fit: "crop"` together with the framing the layer already
 * paints, so the first frame of the mode is pixel-identical to the last frame
 * out of it. It also records the bitmap's natural size when the document never
 * carried one, because the framing is expressed in multiples of a size that has
 * to be known — and a framing that guessed would be worse than a refusal, so a
 * bitmap whose size cannot be read at all reports why instead.
 */
export async function beginImageCrop(deps: BeginImageCropDeps): Promise<boolean> {
  const { docRef, commitSnapshot, target: which, hint } = deps;
  const doc = docRef.current;
  // `findNodeById` rather than the tree lookup: the row may be a resolved clone
  // of an instance child, which exists only inside the instance that projects it.
  const el = findNodeById(doc, which.elId);
  const paint = el ? ((el.fills ?? [])[which.paintIndex] as Paint | undefined) : undefined;
  if (!el || !paint || paint.type !== "image") return false;

  if (el.locked) {
    hint?.(t("component.derivedChildLocked"));
    return false;
  }

  const asset = (doc.assets ?? []).find((a) => a.id === paint.assetId);
  if (!asset?.uri) {
    hint?.(t("image.missingAsset"));
    return false;
  }

  // A recorded size is used as-is; only a document that never carried one pays
  // for the decode.
  const measured = assetNaturalSize(asset) ?? (await measureNaturalSize(asset.uri));
  if (!measured) {
    hint?.(t("image.noSize"));
    return false;
  }

  const crop =
    paint.crop ??
    cropFromFraming({
      box: { width: el.width, height: el.height },
      natural: measured,
      fit: paint.fit,
      focalPoint: paint.focalPoint
    });

  const nextPaint: ImagePaint = { ...paint, fit: "crop", crop };
  const cropped = writeNodeEdit(doc, el.id, (item) => {
    const fills = item.fills ?? [];
    return {
      ...item,
      fillEnabled: true,
      fills: fills.map((f, i) => (i === which.paintIndex ? nextPaint : f))
    };
  });
  // The measured size rides the same snapshot: a document that paints through a
  // crop and does not know its bitmap's size would re-measure on every open.
  const measuredSizes = measured.width === asset.width && measured.height === asset.height
    ? null
    : { width: measured.width, height: measured.height };
  const base = cropped ?? doc;
  const withAssets: DesignDocument = measuredSizes
    ? {
        ...base,
        assets: (base.assets ?? []).map((a) => (a.id === asset.id ? { ...a, ...measuredSizes } : a))
      }
    : base;

  commitSnapshot(withAssets);
  setImageCropTarget(which);
  return true;
}

import { AssetRef, ImagePaint, Paint } from "../core/dsl/types";
import { isNeutralColorFilter } from "../core/dsl/color-filter";
import { appendColorFilterNodes } from "./canvas/color-filter-nodes";
import { SegmentedControl } from "./SegmentedControl";
import { Select } from "./Select";
import { AdjustRows } from "./inspector/AdjustRows";
import { t } from "../i18n";
import { Image as ImageIcon, ImageUp } from "lucide-react";
import { PAINT_SWATCH_CHECKER } from "./inspector/paint-row-style";
import { Button } from "./Button";

/**
 * The body of an image layer: preview, bitmap source, framing, the layer's own
 * colour adjustment, and the way into crop mode.
 *
 * The preview is a picture of the BITMAP — whole, letterboxed into the window —
 * and never of the framing. Framing is edited on the canvas, where the crop
 * chrome and the tile it belongs to are one picture at one scale; a thumbnail
 * that re-framed itself would move under the very handles being dragged and
 * under every Fit segment, which is a second, badly-scaled copy of the control
 * it sits directly above. The bitmap is the one thing in this panel that is not
 * being edited, which is what makes it the one thing worth showing still.
 */
export function ImagePaintBody({
  paint,
  assets,
  onChange,
  onGestureStart,
  onGestureEnd,
  onUpload,
  onEnterCrop,
  cropActive = false,
  slidersMaxHeight,
  pending = false
}: {
  paint: ImagePaint;
  assets: AssetRef[];
  onChange: (paint: Paint, discrete?: boolean) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onUpload: () => void;
  /** Switch this layer to crop mode and hand the canvas the chrome. */
  onEnterCrop?: () => void;
  /** This layer is the one the canvas is currently cropping. */
  cropActive?: boolean;
  /**
   * Height for the axis list's window, or undefined to let the list be its own
   * height. Set by the host while the panel fits the viewport: one scroller,
   * never two.
   */
  slidersMaxHeight?: number;
  /** No bitmap has been chosen yet — framing and adjusting have nothing to act on. */
  pending?: boolean;
}) {
  const asset = assets.find((a) => a.id === paint.assetId);
  const filter = isNeutralColorFilter(paint.adjust) ? undefined : paint.adjust;
  const primitives: any[] = [];
  appendColorFilterNodes(primitives, filter, "SourceGraphic", "cf-paint-preview");

  // The bitmap on its own: no fit, no crop framing, and no element box to frame
  // it into. Everything in this panel that CAN be edited is edited somewhere
  // else, and a preview that stirs while the hand is elsewhere is a preview that
  // claims a change the canvas did not make.
  const src = asset?.uri ? asset.uri : null;

  return (
    <>
      {/* `shrink-0` on every row but the axis list: the panel is a flex column
          while an image is being painted, so when the viewport clamps it, the
          list is the one item that gives — the bar stays inside the list. */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div data-image-asset="1" className="flex-1 min-w-0">
          <Select
            className="w-full"
            value={paint.assetId}
            onChange={(id) => onChange({ ...paint, assetId: id }, true)}
            title={t("image.source")}
          >
            {!asset && <option value={paint.assetId}>{t("image.missingAsset")}</option>}
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          size="icon"
          type="button"
          data-image-upload="1"
          onClick={onUpload}
          title={t("image.upload")}
        >
          <ImageUp size={12} />
        </Button>
      </div>

      <div
        data-image-preview="1"
        className="w-full h-24 shrink-0 rounded-ctl border border-rule-strong overflow-hidden"
        style={{ backgroundImage: PAINT_SWATCH_CHECKER.backgroundImage, backgroundSize: "12px 12px" }}
      >
        {src ? (
          /* No viewBox: the window is the box. `meet` on the bitmap then holds
             the whole picture inside it, whatever the panel's width — a preview
             is the one place the ASSET's aspect ratio is the honest one, since
             the element's is what the framing below is about to change. */
          <svg width="100%" height="100%">
            <defs>
              {primitives.length > 0 && (
                <filter
                  id="cf_paint_preview"
                  x="-10%"
                  y="-10%"
                  width="120%"
                  height="120%"
                  colorInterpolationFilters="sRGB"
                >
                  {primitives}
                </filter>
              )}
            </defs>
            <image
              data-image-preview-bitmap="1"
              href={src}
              x={0}
              y={0}
              width="100%"
              height="100%"
              preserveAspectRatio="xMidYMid meet"
              filter={primitives.length > 0 ? "url(#cf_paint_preview)" : undefined}
            />
          </svg>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon size={18} className="text-ink-muted" />
          </div>
        )}
      </div>

      {!pending && (
        <>
          <div data-image-fit="1" className="shrink-0">
            <SegmentedControl<string>
              className="w-full"
              value={cropActive ? "crop" : paint.fit ?? "cover"}
              onChange={(mode) => {
                // Crop is a MODE, not a fit value: it hands the canvas the chrome
                // and materializes the framing this row already shows.
                if (mode === "crop") onEnterCrop?.();
                else onChange({ ...paint, fit: mode as ImagePaint["fit"] }, true);
              }}
              items={[
                { value: "cover", label: t("image.cover"), grow: true },
                { value: "contain", label: t("image.contain"), grow: true },
                { value: "fill", label: t("image.fill"), grow: true },
                {
                  value: "crop",
                  label: t("image.crop"),
                  grow: true,
                  title: t("image.cropTitle"),
                  attrs: { "data-image-crop": "1" }
                }
              ]}
            />
          </div>

          <div className="pt-2 border-t border-rule-strong flex flex-col min-h-0">
            <AdjustRows
              sectionId="paint-adjust"
              title={t("adjust.layer")}
              filter={paint.adjust}
              onChange={(next, discrete) => onChange({ ...paint, adjust: next }, discrete)}
              onDragStart={onGestureStart}
              onDragEnd={onGestureEnd}
              slidersMaxHeight={slidersMaxHeight}
            />
          </div>
        </>
      )}
    </>
  );
}

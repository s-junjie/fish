import { Plus, Minus, Maximize } from "lucide-react";
import { t } from "../../i18n";
import { formatZoomPercent } from "../../core/geometry/viewport";
import { Button } from "../Button";

interface ZoomControlProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Fit the selection when there is one, else the whole page. */
  onZoomFit: () => void;
  onZoomActualSize: () => void;
}

/**
 * The zoom cluster: step out, the readout, step in, fit.
 *
 * It rides the title bar between the transient save status and Present, which
 * keeps the outer corner.
 *
 * It must not float free: a box answerable to no `data-ui-panel` edge is
 * invisible to `unobstructedArea`, so a fit frames
 * content underneath it. Inside chrome it is carried by that panel's own box,
 * which is already measured, so nothing needs keeping in step when the panel is
 * resized or slides away.
 *
 * The readout is the 100% control. A number sitting between two step buttons is
 * already where the eye lands, and the one zoom nobody needs a menu for is
 * "back to actual size" — so clicking it resets, and the amber it wears is the
 * same signal the old read-only cell used: this figure is live. The two buttons
 * either side are the same `+` / `-` commands the keyboard runs, which is why
 * the tooltips name the keys — the point of having a readout as well as keys is
 * not having to remember which one you are on.
 */
export function ZoomControl({ zoom, onZoomIn, onZoomOut, onZoomFit, onZoomActualSize }: ZoomControlProps) {
  return (
    /* No vertical padding: the title bar is 48px and the buttons are the 26px
       `iconLg` box, so the cluster centres without touching either edge. */
    <div data-zoom-control="true" className="shrink-0 flex items-center">
      <div className="flex items-center gap-0.5">
        <Button
          size="iconLg"
          onClick={onZoomOut}
          data-zoom-out="true"
          title={t("zoom.out")}
          aria-label={t("zoom.out")}
        >
          <Minus size={13} />
        </Button>
        {/* The readout is sized by its own digits, not by a reserved `min-w`:
            a wide centred cell hid its slack in the gap, so the steps read as
            twice as far from the figure as the fit button was from them. Tight,
            every neighbour sits one `gap-0.5` plus each box's own padding away,
            and that stays true whether the figure is `8%` or `6400%`. */}
        <button
          type="button"
          data-zoom-value="true"
          onClick={onZoomActualSize}
          title={t("zoom.actual")}
          aria-label={t("zoom.actual")}
          className="px-1 text-center text-row text-brand tabular-nums select-none rounded-swatch py-0.5 hover:bg-raised transition-colors duration-micro ease-snap cursor-default"
        >
          {formatZoomPercent(zoom)}
        </button>
        <Button
          size="iconLg"
          onClick={onZoomIn}
          data-zoom-in="true"
          title={t("zoom.in")}
          aria-label={t("zoom.in")}
        >
          <Plus size={13} />
        </Button>
        {/* The dock's own group seam, so it reads as the same chrome: stepping
            and fitting are different verbs, and a gap alone leaves them looking
            like four keys of one row. */}
        <div className="w-px h-4 bg-rule-strong mx-1.5" aria-hidden="true" />
        {/* Fit last: stepping is what this cluster is for, and fit is the one
            you press once. It also leaves the number flanked by its own two
            steps instead of by two different verbs. */}
        <Button
          size="iconLg"
          onClick={onZoomFit}
          data-zoom-fit="true"
          title={t("zoom.fit")}
          aria-label={t("zoom.fit")}
        >
          <Maximize size={13} />
        </Button>
      </div>
    </div>
  );
}

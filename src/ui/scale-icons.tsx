import type { PresentScaleMode } from "./present/presentScale";

/**
 * The five ways content can meet its frame — ONE family, drawn once.
 *
 * The shared subject is the screen (the rounded frame) and the fullscreen
 * button beside it owns the opposite mark: four corner brackets and no frame.
 * That split is the whole point of the module. The earlier set drew `fill` as
 * four corner brackets — the fullscreen glyph over again — and `fit` as four
 * inward arrows, which at 14px are the same brackets pointing the other way, so
 * three controls read as one. A mode is now recognized by what it does to the
 * frame, never by a new subject per icon:
 *
 *   - `actual`     a numeral in the frame — the one mode that is a literal scale
 *   - `responsive` a DASHED screen — the frame is what adapts, the slide is fixed
 *   - `fit-width`  an arrow that spans the frame — one axis is pinned
 *   - `fit`        an outlined slide inside — everything visible, margins around it
 *   - `fill`       a solid slide inside — it covers the screen, nothing shows through
 *
 * The editor's title-bar fit, the reader's zoom pill and the deck all borrow
 * `fill` rather than drawing their own: "the page meets the frame" is one
 * statement, and a second glyph for it would be the drift this module exists to
 * prevent.
 */
export function ScaleModeIcon({
  mode,
  size = 14
}: {
  mode: PresentScaleMode;
  size?: number;
}) {
  const screen = (
    <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.8" stroke="currentColor" strokeWidth="1.3" fill="none" />
  );
  switch (mode) {
    case "actual":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
          {screen}
          <text x="8" y="9.9" textAnchor="middle" fontSize="6.2" fontWeight="700" fill="currentColor" fontFamily="monospace">
            1:1
          </text>
        </svg>
      );
    case "responsive":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
          <rect
            x="1.6"
            y="2.6"
            width="12.8"
            height="10.8"
            rx="1.8"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeDasharray="2 1.8"
            fill="none"
          />
          <rect x="4.6" y="5.6" width="6.8" height="4.8" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none" />
        </svg>
      );
    case "fit-width":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
          {screen}
          <path
            d="M12.4 8H3.6 M5.7 5.9 3.5 8l2.2 2.1 M10.3 5.9 12.5 8l-2.2 2.1"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case "fit":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
          {screen}
          <rect x="4.2" y="5.2" width="7.6" height="5.6" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none" />
        </svg>
      );
    case "fill":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
          {screen}
          <rect x="4.2" y="5.2" width="7.6" height="5.6" rx="1" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

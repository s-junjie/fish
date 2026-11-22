/**
 * The section glyph, drawn after Figma's: a rounded box with a small pane folded
 * into its top-left corner.
 *
 * The pane is the whole statement — a frame is a plain box (`#`), while a section
 * is a box with a NAME plate on it, and the plate is drawn where the label is.
 * Hand-drawn rather than a lucide icon because no stock set has this shape: the
 * nearest candidates are a dashed rectangle with corner dots (`BoxSelect`) or a
 * four-bracket scan frame (`Scan`), and both read as "selection", not as
 * "region with a title".
 */
export function SectionMark({
  size = 13,
  className = "",
  strokeWidth = 1.5
}: {
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const stroke = {
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    fill: "none"
  } as const;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className} aria-hidden="true">
      <rect x="1.2" y="1.2" width="11.6" height="11.6" rx="3" {...stroke} />
      <path d="M1.2 5.6H5.4V1.2" {...stroke} />
    </svg>
  );
}

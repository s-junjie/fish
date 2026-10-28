/**
 * The handful of glyphs the plugin panels draw, as geometry rather than a package.
 *
 * `lucide-react` pulls React (aliased to `preact/compat` in the shell) and a
 * component factory. A plugin is a standalone `blob:` module, so importing it
 * would drag a second compatibility layer into a bundle that already gets its
 * runtime from the host. These paths are the same drawings, at the same 24×24
 * box and stroke, with nothing between the panel and an `<svg>`.
 *
 * Geometry from Lucide (ISC). Stroke 2, round caps and joins, `currentColor`.
 */
import type { ComponentChildren } from "preact";

interface GlyphProps {
  size?: number;
  className?: string;
}

const BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const
};

function Glyph({ size = 14, className, children }: GlyphProps & { children: ComponentChildren }) {
  return (
    <svg {...BASE} width={size} height={size} className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export function SearchGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Glyph>
  );
}

export function SpinnerGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </Glyph>
  );
}

export function ImageGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </Glyph>
  );
}

export function ScissorsGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.12 15.88" />
      <path d="M14.47 14.48 20 20" />
      <path d="M8.12 8.12 12 12" />
    </Glyph>
  );
}

export function UndoGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Glyph>
  );
}

export function CheckGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  );
}

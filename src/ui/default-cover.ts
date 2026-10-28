import type { ThumbnailArt } from "./thumbnail-svg";
import {
  WORDMARK_CELL,
  WORDMARK_CLOSE,
  WORDMARK_LETTERS,
  WORDMARK_OPEN,
  WORDMARK_UNITS
} from "./fish-wordmark";

/**
 * The cover a saved file falls back to when its document has nothing to paint.
 *
 * Without it an empty document saves with no preview block at all, and every
 * viewer that reads the file without running it — a Finder icon, a chat
 * attachment card, a phone's preview sheet — has a blank to draw. A blank is
 * indistinguishable from a broken file, so the resting state gets a picture: the
 * wordmark on the paper, its i dotted with the brand's own cell, and the product
 * line set under it.
 *
 * Colours are DESIGN.md tokens written as hex on purpose. This markup is baked
 * into the file and read by viewers that never load FISH's stylesheet, so a
 * `var(--fish-*)` would resolve to nothing there.
 */
const PAPER = "#101010"; // colors.paper
const INK = "#ECF3F8"; // colors.ink
const BRAND = "#E8A33D"; // colors.brand
const INK_MUTED = "#666C70"; // colors.ink-muted

const WIDTH = 1600;
const HEIGHT = 1000;

/** Sized so the wordmark reads at 96px; the line under it reads as a rule of text. */
const WORDMARK_WIDTH = 740;
const WORDMARK_CENTRE_Y = 470;
const CAPTION_Y = WORDMARK_CENTRE_Y + 170;

export function buildDefaultCover(): ThumbnailArt {
  const k = WORDMARK_WIDTH / WORDMARK_UNITS.width;
  const originX = WIDTH / 2 - (WORDMARK_UNITS.width / 2) * k;
  const originY = WORDMARK_CENTRE_Y - (WORDMARK_UNITS.height / 2) * k;
  const box = (x: number, y: number, size: number, rx: number, fill: string) =>
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}" fill="${fill}" />`;

  return {
    // Sized by its own box rather than by `width:100%;height:100%` alone: this
    // SVG is the whole picture, so letting the viewer letterbox it inside the
    // wrapper's paper is what keeps the lockup centred in a card of any shape.
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:100%">` +
      `<rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}" />` +
      `<g transform="translate(${originX} ${originY}) scale(${k})">` +
      `<path d="${WORDMARK_LETTERS}" fill="${INK}" />` +
      `<path d="${WORDMARK_OPEN}" fill="${BRAND}" />` +
      `<path d="${WORDMARK_CLOSE}" fill="${BRAND}" />` +
      box(WORDMARK_CELL.x, WORDMARK_CELL.y, WORDMARK_CELL.size, WORDMARK_CELL.rx, BRAND) +
      `</g>` +
      `<text x="${WIDTH / 2}" y="${CAPTION_Y}" text-anchor="middle" fill="${INK_MUTED}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="26" letter-spacing="9">SINGLE-FILE DESIGN DOCUMENT</text>` +
      `</svg>`,
    width: WIDTH,
    height: HEIGHT,
    background: PAPER
  };
}

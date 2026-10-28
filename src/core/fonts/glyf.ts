import { commandsToPathData, GlyphCommand } from "./glyph-path";
import { SfntFont, requireTable } from "./sfnt";

/**
 * `glyf` + `loca`: one glyph's outline, as SVG path commands in font units.
 *
 * Coordinates stay on the font's own axes (y up). Flipping into SVG's downward
 * y is a rendering decision, so it belongs to the caller rather than here.
 *
 * TrueType points are either on the curve or control points, and two adjacent
 * control points imply an on-curve point exactly halfway between them. That
 * implied point is stored nowhere, so it is synthesised while walking.
 *
 * Composite glyphs — accented letters, most of CJK — are references carrying a
 * transform, expanded by recursion.
 */

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

const F2DOT14 = 16384;
const MAX_COMPOSITE_DEPTH = 8;

export interface GlyphPoint {
  x: number;
  y: number;
  onCurve: boolean;
}

export type GlyphContour = GlyphPoint[];

class Cursor {
  constructor(private readonly view: DataView, public at: number) {}
  u8(): number {
    return this.view.getUint8(this.at++);
  }
  u16(): number {
    const value = this.view.getUint16(this.at);
    this.at += 2;
    return value;
  }
  i16(): number {
    const value = this.view.getInt16(this.at);
    this.at += 2;
    return value;
  }
  i8(): number {
    return this.view.getInt8(this.at++);
  }
  skip(count: number): void {
    this.at += count;
  }
}

export function glyphOutline(font: SfntFont, glyphId: number): string | null {
  const commands = glyphCommands(font, glyphId);
  return commands.length === 0 ? null : commandsToPathData(commands);
}

export function glyphCommands(font: SfntFont, glyphId: number): GlyphCommand[] {
  return contoursToCommands(glyphContours(font, glyphId));
}

/**
 * The raw contours, for a caller that has to move them before serialising —
 * placing a glyph at a pen position and flipping the y axis cannot be done on
 * the path string without parsing it again.
 */
export function glyphContours(font: SfntFont, glyphId: number): GlyphContour[] {
  return collectContours(font, glyphId, 0);
}

function collectContours(font: SfntFont, glyphId: number, depth: number): GlyphContour[] {
  if (glyphId < 0 || glyphId >= font.numGlyphs) return [];
  const start = glyphStart(font, glyphId);
  if (start === null) return [];
  const numContours = font.view.getInt16(start);
  return numContours < 0
    ? compositeContours(font, start + 10, depth)
    : simpleContours(font, start + 10, numContours);
}

/** Absolute offset of the glyph record in `glyf`, or null when it is empty. */
function glyphStart(font: SfntFont, glyphId: number): number | null {
  const loca = requireTable(font.tables, font.bytes, "loca");
  const glyf = requireTable(font.tables, font.bytes, "glyf");
  const long = font.indexToLocFormat === 1;
  const read = (index: number): number =>
    long
      ? font.view.getUint32(loca.offset + index * 4)
      : font.view.getUint16(loca.offset + index * 2) * 2;
  const start = read(glyphId);
  return read(glyphId + 1) > start ? glyf.offset + start : null;
}

function simpleContours(font: SfntFont, offset: number, numContours: number): GlyphContour[] {
  const cursor = new Cursor(font.view, offset);
  const endPoints: number[] = [];
  for (let i = 0; i < numContours; i++) endPoints.push(cursor.u16());
  cursor.skip(cursor.u16());

  const numPoints = numContours > 0 ? endPoints[numContours - 1] + 1 : 0;
  const flags: number[] = [];
  while (flags.length < numPoints) {
    const flag = cursor.u8();
    flags.push(flag);
    if (flag & REPEAT) {
      for (let repeat = cursor.u8(); repeat > 0; repeat--) flags.push(flag);
    }
  }

  const xs = readCoordinates(cursor, flags, X_SHORT, X_SAME_OR_POSITIVE);
  const ys = readCoordinates(cursor, flags, Y_SHORT, Y_SAME_OR_POSITIVE);
  const points: GlyphContour = flags.map((flag, i) => ({
    x: xs[i],
    y: ys[i],
    onCurve: (flag & ON_CURVE) !== 0
  }));

  const contours: GlyphContour[] = [];
  let start = 0;
  for (const end of endPoints) {
    if (end >= start) contours.push(points.slice(start, end + 1));
    start = end + 1;
  }
  return contours;
}

function readCoordinates(
  cursor: Cursor,
  flags: number[],
  shortBit: number,
  sameBit: number
): number[] {
  const out: number[] = [];
  let value = 0;
  for (const flag of flags) {
    if (flag & shortBit) value += flag & sameBit ? cursor.u8() : -cursor.u8();
    else if (!(flag & sameBit)) value += cursor.i16();
    out.push(value);
  }
  return out;
}

function compositeContours(font: SfntFont, offset: number, depth: number): GlyphContour[] {
  if (depth >= MAX_COMPOSITE_DEPTH) return [];
  const cursor = new Cursor(font.view, offset);
  const out: GlyphContour[] = [];

  for (;;) {
    const flags = cursor.u16();
    const glyphId = cursor.u16();

    let dx = 0;
    let dy = 0;
    if (flags & ARG_1_AND_2_ARE_WORDS) {
      const arg1 = cursor.i16();
      const arg2 = cursor.i16();
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = arg1;
        dy = arg2;
      }
    } else {
      const arg1 = cursor.i8();
      const arg2 = cursor.i8();
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = arg1;
        dy = arg2;
      }
    }

    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & WE_HAVE_A_SCALE) {
      a = d = cursor.i16() / F2DOT14;
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      a = cursor.i16() / F2DOT14;
      d = cursor.i16() / F2DOT14;
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      a = cursor.i16() / F2DOT14;
      b = cursor.i16() / F2DOT14;
      c = cursor.i16() / F2DOT14;
      d = cursor.i16() / F2DOT14;
    }

    for (const contour of collectContours(font, glyphId, depth + 1)) {
      out.push(
        contour.map((point) => ({
          x: a * point.x + c * point.y + dx,
          y: b * point.x + d * point.y + dy,
          onCurve: point.onCurve
        }))
      );
    }

    if (!(flags & MORE_COMPONENTS)) break;
  }
  return out;
}

export function contoursToCommands(contours: GlyphContour[]): GlyphCommand[] {
  const out: GlyphCommand[] = [];
  for (const contour of contours) appendContour(contour, out);
  return out;
}

function appendContour(points: GlyphContour, out: GlyphCommand[]): void {
  const count = points.length;
  if (count === 0) return;

  let startIndex = -1;
  for (let i = 0; i < count; i++) {
    if (points[i].onCurve) {
      startIndex = i;
      break;
    }
  }

  const start =
    startIndex >= 0
      ? points[startIndex]
      : {
          x: (points[count - 1].x + points[0].x) / 2,
          y: (points[count - 1].y + points[0].y) / 2,
          onCurve: true
        };
  const first = startIndex >= 0 ? startIndex + 1 : 0;

  out.push({ type: "M", x: start.x, y: start.y });

  let control: GlyphPoint | null = null;
  for (let k = 0; k < count; k++) {
    const point = points[(first + k) % count];
    const closing = k === count - 1;
    if (point.onCurve) {
      if (control) {
        out.push({ type: "Q", cx: control.x, cy: control.y, x: point.x, y: point.y });
        control = null;
      } else if (!closing) {
        out.push({ type: "L", x: point.x, y: point.y });
      }
    } else {
      if (control) {
        out.push({
          type: "Q",
          cx: control.x,
          cy: control.y,
          x: (control.x + point.x) / 2,
          y: (control.y + point.y) / 2
        });
      }
      control = point;
    }
  }

  if (control) out.push({ type: "Q", cx: control.x, cy: control.y, x: start.x, y: start.y });
  out.push({ type: "Z" });
}

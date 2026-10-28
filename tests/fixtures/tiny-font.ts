/**
 * A hand-built TrueType font, so the outline reader can be tested against
 * known-good answers without shipping a licensed binary or depending on
 * whatever fonts the machine happens to have.
 *
 * Five glyphs, each chosen to exercise one branch of the reader:
 *   0 `.notdef`  a square made of on-curve points        -> straight lines
 *   1 'A'        a triangle                              -> three lines
 *   2 'B'        two adjacent off-curve points           -> implied midpoint
 *   3 'C'        a composite reference to glyph 1        -> transform + recursion
 *   4 'D'        hand-encoded short deltas + REPEAT      -> compressed coordinates
 *   5            zero-length `loca` entry                -> blank glyph
 */

const UNITS_PER_EM = 1000;
const NUM_GLYPHS = 6;

interface FixturePoint {
  x: number;
  y: number;
  onCurve: boolean;
}

const pushU16 = (out: number[], value: number): void => {
  out.push((value >> 8) & 0xff, value & 0xff);
};

const pushI16 = (out: number[], value: number): void => {
  pushU16(out, value < 0 ? value + 0x10000 : value);
};

const pushU32 = (out: number[], value: number): void => {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
};

const tagToUint32 = (tag: string): number =>
  (((tag.charCodeAt(0) << 24) |
    (tag.charCodeAt(1) << 16) |
    (tag.charCodeAt(2) << 8) |
    tag.charCodeAt(3)) >>>
    0);

function simpleGlyph(points: FixturePoint[]): number[] {
  const out: number[] = [];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  pushI16(out, 1);
  pushI16(out, Math.min(...xs));
  pushI16(out, Math.min(...ys));
  pushI16(out, Math.max(...xs));
  pushI16(out, Math.max(...ys));
  pushU16(out, points.length - 1);
  pushU16(out, 0);
  for (const point of points) out.push(point.onCurve ? 0x01 : 0x00);
  let previous = 0;
  for (const point of points) {
    pushI16(out, point.x - previous);
    previous = point.x;
  }
  previous = 0;
  for (const point of points) {
    pushI16(out, point.y - previous);
    previous = point.y;
  }
  return out;
}

function compositeGlyph(glyphIndex: number, dx: number, dy: number): number[] {
  const out: number[] = [];
  pushI16(out, -1);
  pushI16(out, 0);
  pushI16(out, 0);
  pushI16(out, UNITS_PER_EM);
  pushI16(out, UNITS_PER_EM);
  pushU16(out, 0x0001 | 0x0002);
  pushU16(out, glyphIndex);
  pushI16(out, dx);
  pushI16(out, dy);
  return out;
}

/** One REPEAT run, then a point whose x delta goes backwards. */
function compressedSquareGlyph(): number[] {
  const out: number[] = [];
  pushI16(out, 1);
  pushI16(out, 0);
  pushI16(out, 0);
  pushI16(out, 200);
  pushI16(out, 200);
  pushU16(out, 3);
  pushU16(out, 0);
  out.push(0x01 | 0x02 | 0x04 | 0x10 | 0x20 | 0x08, 2);
  out.push(0x01 | 0x02 | 0x04 | 0x20);
  out.push(0, 200, 0, 200);
  out.push(0, 0, 200, 0);
  return out;
}

function headTable(): number[] {
  const out: number[] = [];
  pushU32(out, 0x00010000);
  pushU32(out, 0x00010000);
  pushU32(out, 0);
  pushU32(out, 0x5f0f3cf5);
  pushU16(out, 0);
  pushU16(out, UNITS_PER_EM);
  for (let i = 0; i < 4; i++) pushU32(out, 0);
  pushI16(out, 0);
  pushI16(out, 0);
  pushI16(out, UNITS_PER_EM);
  pushI16(out, UNITS_PER_EM);
  pushU16(out, 0);
  pushU16(out, 8);
  pushI16(out, 2);
  pushI16(out, 1);
  pushI16(out, 0);
  return out;
}

function hheaTable(): number[] {
  const out: number[] = [];
  pushU32(out, 0x00010000);
  pushI16(out, 800);
  pushI16(out, -200);
  pushI16(out, 0);
  pushU16(out, UNITS_PER_EM);
  pushI16(out, 0);
  pushI16(out, 0);
  pushI16(out, UNITS_PER_EM);
  pushI16(out, 1);
  pushI16(out, 0);
  pushI16(out, 0);
  for (let i = 0; i < 4; i++) pushI16(out, 0);
  pushI16(out, 0);
  pushU16(out, NUM_GLYPHS);
  return out;
}

function maxpTable(): number[] {
  const out: number[] = [];
  pushU32(out, 0x00010000);
  pushU16(out, NUM_GLYPHS);
  for (let i = 0; i < 13; i++) pushU16(out, 0);
  return out;
}

function hmtxTable(): number[] {
  const out: number[] = [];
  for (let i = 0; i < NUM_GLYPHS; i++) {
    pushU16(out, UNITS_PER_EM);
    pushI16(out, 0);
  }
  return out;
}

/** One segment, 'A'..'D' -> glyph 1..4, in whichever format the caller wants. */
function cmapTable(format: 4 | 12): number[] {
  const out: number[] = [];
  pushU16(out, 0);
  pushU16(out, 1);
  pushU16(out, 3);
  pushU16(out, format === 12 ? 10 : 1);
  pushU32(out, 12);

  if (format === 12) {
    pushU16(out, 12);
    pushU16(out, 0);
    pushU32(out, 28);
    pushU32(out, 0);
    pushU32(out, 1);
    pushU32(out, 0x41);
    pushU32(out, 0x44);
    pushU32(out, 1);
    return out;
  }

  pushU16(out, 4);
  pushU16(out, 24);
  pushU16(out, 0);
  pushU16(out, 2);
  pushU16(out, 2);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0x44);
  pushU16(out, 0);
  pushU16(out, 0x41);
  pushI16(out, 1 - 0x41);
  pushU16(out, 0);
  return out;
}

export function buildTinyFont(options: { cmapFormat?: 4 | 12 } = {}): Uint8Array {
  const glyphs = [
    simpleGlyph([
      { x: 100, y: 0, onCurve: true },
      { x: 900, y: 0, onCurve: true },
      { x: 900, y: 700, onCurve: true },
      { x: 100, y: 700, onCurve: true }
    ]),
    simpleGlyph([
      { x: 100, y: 0, onCurve: true },
      { x: 500, y: 700, onCurve: true },
      { x: 900, y: 0, onCurve: true }
    ]),
    simpleGlyph([
      { x: 0, y: 0, onCurve: true },
      { x: 250, y: 700, onCurve: false },
      { x: 750, y: 700, onCurve: false },
      { x: 1000, y: 0, onCurve: true }
    ]),
    compositeGlyph(1, 200, 100),
    compressedSquareGlyph(),
    []
  ];

  const loca: number[] = [];
  let cursor = 0;
  for (const glyph of glyphs) {
    pushU32(loca, cursor);
    cursor += glyph.length;
  }
  pushU32(loca, cursor);

  const tables = [
    { tag: "cmap", data: cmapTable(options.cmapFormat ?? 4) },
    { tag: "glyf", data: glyphs.flat() },
    { tag: "head", data: headTable() },
    { tag: "hhea", data: hheaTable() },
    { tag: "hmtx", data: hmtxTable() },
    { tag: "loca", data: loca },
    { tag: "maxp", data: maxpTable() }
  ];

  const header: number[] = [];
  pushU32(header, 0x00010000);
  pushU16(header, tables.length);
  pushU16(header, 64);
  pushU16(header, 2);
  pushU16(header, 48);

  const records: number[] = [];
  const body: number[] = [];
  let offset = 12 + tables.length * 16;
  for (const table of tables) {
    pushU32(records, tagToUint32(table.tag));
    pushU32(records, 0);
    pushU32(records, offset);
    pushU32(records, table.data.length);
    body.push(...table.data);
    const padded = Math.ceil(table.data.length / 4) * 4;
    for (let i = table.data.length; i < padded; i++) body.push(0);
    offset += padded;
  }

  return new Uint8Array([...header, ...records, ...body]);
}

export const TINY_FONT_EXPECTED = {
  unitsPerEm: UNITS_PER_EM,
  ascender: 800,
  descender: -200,
  numGlyphs: NUM_GLYPHS,
  notdef: "M100 0L900 0L900 700L100 700Z",
  a: "M100 0L500 700L900 0Z",
  b: "M0 0Q250 700 500 700Q750 700 1000 0Z",
  c: "M300 100L700 800L1100 100Z",
  d: "M0 0L200 0L200 200L0 200Z"
} as const;

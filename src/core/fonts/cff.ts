import { GlyphCommand } from "./glyph-path";
import { FontParseError, SfntFont, requireTable } from "./sfnt";

/**
 * `CFF ` outlines: the format macOS ships its CJK fonts in — PingFang SC,
 * Hiragino Sans, Apple SD Gothic Neo are all CFF, so without this the default
 * Chinese text in the app cannot be outlined at all.
 *
 * Two things differ from `glyf` and both cost code: the curves are cubic rather
 * than quadratic, and the outlines are *programs* — a Type2 charstring is a
 * stack machine that can call local and global subroutines, so reading it means
 * interpreting it rather than walking a point array.
 *
 * Coordinates stay on the font's axes (y up), like `glyf`.
 */

interface CffIndex {
  count: number;
  /** Absolute offset of item `i`, valid for `i` in `[0, count]`. */
  offsetAt(i: number): number;
}

const MAX_STACK = 48;
const MAX_CALL_DEPTH = 10;

export function buildCffOutline(font: SfntFont): (glyphId: number) => GlyphCommand[] {
  const table = requireTable(font.tables, font.bytes, "CFF ");
  const view = font.view;
  const base = table.offset;

  let at = base + view.getUint8(base + 2);
  at = skipIndex(view, at); // Name INDEX
  const topDict = readIndex(view, at);
  at = topDict.end;
  at = skipIndex(view, at); // String INDEX
  const globalSubrs = readIndex(view, at);

  const topStart = topDict.offsetAt(0);
  const top = readDict(view, topStart, topDict.offsetAt(1));

  const charStrings = readIndex(view, base + first(top, 17, "CharStrings"));
  const fdArray = top.has(1236) ? readIndex(view, base + first(top, 1236)) : null;
  const fdSelect = top.has(1237) ? base + first(top, 1237) : -1;

  // CID-keyed fonts (all of the CJK ones) carry a Private DICT per font
  // dictionary and an FDSelect that says which one a glyph belongs to. A plain
  // font has a single Private DICT and no FDSelect.
  const privates: PrivateInfo[] = [];
  if (fdArray) {
    for (let i = 0; i < fdArray.count; i++) {
      const dict = readDict(view, fdArray.offsetAt(i), fdArray.offsetAt(i + 1));
      privates.push(readPrivate(view, base, dict));
    }
  } else {
    privates.push(readPrivate(view, base, top));
  }

  const privateFor = (glyphId: number): PrivateInfo => {
    if (privates.length === 1) return privates[0];
    return privates[fdIndexFor(view, fdSelect, glyphId)] ?? privates[0];
  };

  return (glyphId: number): GlyphCommand[] => {
    if (glyphId < 0 || glyphId >= charStrings.count) return [];
    const info = privateFor(glyphId);
    const state = new CharStringState(
      view,
      globalSubrs,
      info.localSubrs,
      info.defaultWidthX,
      info.nominalWidthX
    );
    state.run(charStrings.offsetAt(glyphId), charStrings.offsetAt(glyphId + 1), 0);
    return state.commands;
  };
}

interface PrivateInfo {
  localSubrs: CffIndex | null;
  defaultWidthX: number;
  nominalWidthX: number;
}

function readPrivate(view: DataView, base: number, dict: Map<number, number[]>): PrivateInfo {
  const entry = dict.get(18);
  const fallback: PrivateInfo = { localSubrs: null, defaultWidthX: 0, nominalWidthX: 0 };
  if (!entry || entry.length < 2) return fallback;

  const [size, offset] = entry;
  const start = base + offset;
  const privateDict = readDict(view, start, start + size);
  const subrsOffset = privateDict.get(19)?.[0];
  return {
    localSubrs: subrsOffset === undefined ? null : readIndex(view, start + subrsOffset),
    defaultWidthX: privateDict.get(20)?.[0] ?? 0,
    nominalWidthX: privateDict.get(21)?.[0] ?? 0
  };
}

function fdIndexFor(view: DataView, fdSelect: number, glyphId: number): number {
  if (fdSelect < 0) return 0;
  const format = view.getUint8(fdSelect);
  if (format === 0) return view.getUint8(fdSelect + 1 + glyphId);
  if (format !== 3) return 0;
  const ranges = view.getUint16(fdSelect + 1);
  let result = 0;
  for (let i = 0; i < ranges; i++) {
    const first = view.getUint16(fdSelect + 3 + i * 3);
    if (first > glyphId) break;
    result = view.getUint8(fdSelect + 3 + i * 3 + 2);
  }
  return result;
}

function first(dict: Map<number, number[]>, key: number, label?: string): number {
  const value = dict.get(key)?.[0];
  if (value === undefined) {
    throw new FontParseError("malformed", `CFF Top DICT has no ${label ?? key}`);
  }
  return value;
}

// ---- INDEX / DICT ----

interface ParsedIndex {
  count: number;
  offsetAt(i: number): number;
  end: number;
}

function readIndex(view: DataView, at: number): ParsedIndex {
  const count = view.getUint16(at);
  if (count === 0) {
    return { count: 0, offsetAt: () => at, end: at + 2 };
  }
  const offSize = view.getUint8(at + 2);
  const offsetsAt = at + 3;
  const dataStart = offsetsAt + (count + 1) * offSize;
  const read = (i: number): number => {
    let value = 0;
    for (let k = 0; k < offSize; k++) value = value * 256 + view.getUint8(offsetsAt + i * offSize + k);
    return dataStart + value - 1;
  };
  return { count, offsetAt: read, end: read(count) };
}

function skipIndex(view: DataView, at: number): number {
  return readIndex(view, at).end;
}

function readDict(view: DataView, start: number, end: number): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  const operands: number[] = [];
  let at = start;

  while (at < end) {
    const b0 = view.getUint8(at++);
    if (b0 === 28) {
      operands.push(view.getInt16(at));
      at += 2;
    } else if (b0 === 29) {
      operands.push(view.getInt32(at));
      at += 4;
    } else if (b0 === 30) {
      const real = readReal(view, at);
      operands.push(real.value);
      at = real.next;
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + view.getUint8(at++) + 108);
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - view.getUint8(at++) - 108);
    } else if (b0 === 12) {
      const op = 1200 + view.getUint8(at++);
      dict.set(op, operands.slice());
      operands.length = 0;
    } else {
      dict.set(b0, operands.slice());
      operands.length = 0;
    }
  }
  return dict;
}

function readReal(view: DataView, at: number): { value: number; next: number } {
  let text = "";
  let done = false;
  while (!done) {
    const byte = view.getUint8(at++);
    for (const nibble of [byte >> 4, byte & 0x0f]) {
      if (nibble <= 9) text += String(nibble);
      else if (nibble === 10) text += ".";
      else if (nibble === 11) text += "E";
      else if (nibble === 12) text += "E-";
      else if (nibble === 14) text += "-";
      else if (nibble === 15) {
        done = true;
        break;
      }
    }
  }
  return { value: Number.parseFloat(text) || 0, next: at };
}

// ---- Type2 charstrings ----

class CharStringState {
  readonly commands: GlyphCommand[] = [];
  private readonly stack: number[] = [];
  private x = 0;
  private y = 0;
  private stemCount = 0;
  private widthTaken = false;
  private open = false;

  constructor(
    private readonly view: DataView,
    private readonly globalSubrs: CffIndex,
    private readonly localSubrs: CffIndex | null,
    private readonly defaultWidthX: number,
    private readonly nominalWidthX: number
  ) {}

  run(start: number, end: number, depth: number): void {
    if (depth > MAX_CALL_DEPTH) return;
    let at = start;

    while (at < end) {
      const b0 = this.view.getUint8(at++);

      if (b0 === 28) {
        this.push(this.view.getInt16(at));
        at += 2;
        continue;
      }
      if (b0 >= 32 && b0 <= 246) {
        this.push(b0 - 139);
        continue;
      }
      if (b0 >= 247 && b0 <= 250) {
        this.push((b0 - 247) * 256 + this.view.getUint8(at++) + 108);
        continue;
      }
      if (b0 >= 251 && b0 <= 254) {
        this.push(-(b0 - 251) * 256 - this.view.getUint8(at++) - 108);
        continue;
      }
      if (b0 === 255) {
        this.push(this.view.getInt32(at) / 65536);
        at += 4;
        continue;
      }

      switch (b0) {
        case 1:
        case 3:
        case 18:
        case 23:
          this.takeWidth(true);
          this.stemCount += this.stack.length >> 1;
          this.stack.length = 0;
          break;
        case 19:
        case 20:
          this.takeWidth(true);
          this.stemCount += this.stack.length >> 1;
          this.stack.length = 0;
          at += (this.stemCount + 7) >> 3;
          break;
        case 21:
          this.takeWidth(false);
          this.move(this.stack[0] ?? 0, this.stack[1] ?? 0);
          break;
        case 22:
          this.takeWidth(false);
          this.move(this.stack[0] ?? 0, 0);
          break;
        case 4:
          this.takeWidth(false);
          this.move(0, this.stack[0] ?? 0);
          break;
        case 5:
          for (let i = 0; i + 1 < this.stack.length; i += 2) {
            this.line(this.stack[i], this.stack[i + 1]);
          }
          this.stack.length = 0;
          break;
        case 6:
        case 7: {
          let horizontal = b0 === 6;
          for (const delta of this.stack) {
            this.line(horizontal ? delta : 0, horizontal ? 0 : delta);
            horizontal = !horizontal;
          }
          this.stack.length = 0;
          break;
        }
        case 8:
          for (let i = 0; i + 5 < this.stack.length; i += 6) this.curveFrom(this.stack, i);
          this.stack.length = 0;
          break;
        case 24:
          this.rcurveline();
          break;
        case 25:
          this.rlinecurve();
          break;
        case 26:
          this.vvcurveto();
          break;
        case 27:
          this.hhcurveto();
          break;
        case 30:
          this.alternatingCurveto(false);
          break;
        case 31:
          this.alternatingCurveto(true);
          break;
        case 10:
          this.callSubroutine(this.localSubrs, depth);
          break;
        case 29:
          this.callSubroutine(this.globalSubrs, depth);
          break;
        case 11:
          return;
        case 14:
          if (!this.widthTaken) {
            this.takeWidth(false);
            if (this.stack.length > 0) {
              this.width = this.nominalWidthX + this.stack[0];
            }
          }
          this.stack.length = 0;
          return;
        case 12:
          at = this.escape(at);
          break;
        default:
          this.stack.length = 0;
          break;
      }
    }
  }

  private width = 0;

  private push(value: number): void {
    if (this.stack.length < MAX_STACK) this.stack.push(value);
  }

  /** The first stack-clearing operator may carry the glyph's width in front. */
  private takeWidth(stems: boolean): void {
    if (this.widthTaken) return;
    this.widthTaken = true;
    const extra = stems ? this.stack.length % 2 === 1 : this.stack.length > this.expectedArgs();
    if (extra && this.stack.length > 0) {
      this.width = this.nominalWidthX + this.stack.shift()!;
    } else {
      this.width = this.defaultWidthX;
    }
  }

  private expectedArgs(): number {
    return 2;
  }

  private move(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.commands.push({ type: "M", x: this.x, y: this.y });
    this.open = true;
    this.stack.length = 0;
  }

  private line(dx: number, dy: number): void {
    if (!this.open) this.move(0, 0);
    this.x += dx;
    this.y += dy;
    this.commands.push({ type: "L", x: this.x, y: this.y });
  }

  private curveFrom(stack: number[], i: number): void {
    if (!this.open) this.move(0, 0);
    const c1x = this.x + stack[i];
    const c1y = this.y + stack[i + 1];
    const c2x = c1x + stack[i + 2];
    const c2y = c1y + stack[i + 3];
    this.x = c2x + stack[i + 4];
    this.y = c2y + stack[i + 5];
    this.commands.push({ type: "C", c1x, c1y, c2x, c2y, x: this.x, y: this.y });
  }

  private rcurveline(): void {
    const stack = this.stack;
    let i = 0;
    while (stack.length - i > 2) {
      this.curveFrom(stack, i);
      i += 6;
    }
    if (stack.length - i >= 2) this.line(stack[i], stack[i + 1]);
    this.stack.length = 0;
  }

  private rlinecurve(): void {
    const stack = this.stack;
    let i = 0;
    while (stack.length - i > 6) {
      this.line(stack[i], stack[i + 1]);
      i += 2;
    }
    while (i + 5 < stack.length) {
      this.curveFrom(stack, i);
      i += 6;
    }
    this.stack.length = 0;
  }

  private hhcurveto(): void {
    const stack = this.stack;
    let i = 0;
    let dy1 = 0;
    if (stack.length % 4 === 1) dy1 = stack[i++];
    for (; i + 3 < stack.length; i += 4) {
      if (!this.open) this.move(0, 0);
      const c1x = this.x + stack[i];
      const c1y = this.y + dy1;
      const c2x = c1x + stack[i + 1];
      const c2y = c1y + stack[i + 2];
      this.x = c2x + stack[i + 3];
      this.y = c2y;
      this.commands.push({ type: "C", c1x, c1y, c2x, c2y, x: this.x, y: this.y });
      dy1 = 0;
    }
    this.stack.length = 0;
  }

  private vvcurveto(): void {
    const stack = this.stack;
    let i = 0;
    let dx1 = 0;
    if (stack.length % 4 === 1) dx1 = stack[i++];
    for (; i + 3 < stack.length; i += 4) {
      if (!this.open) this.move(0, 0);
      const c1x = this.x + dx1;
      const c1y = this.y + stack[i];
      const c2x = c1x + stack[i + 1];
      const c2y = c1y + stack[i + 2];
      this.x = c2x;
      this.y = c2y + stack[i + 3];
      this.commands.push({ type: "C", c1x, c1y, c2x, c2y, x: this.x, y: this.y });
      dx1 = 0;
    }
    this.stack.length = 0;
  }

  /**
   * `hvcurveto` / `vhcurveto`: four arguments per curve, alternating which axis
   * leads. A trailing fifth argument is the other axis of the LAST curve, which
   * is why the step is conditional rather than fixed.
   */
  private alternatingCurveto(startHorizontal: boolean): void {
    const stack = this.stack;
    let i = 0;
    let horizontal = startHorizontal;
    while (i + 3 < stack.length) {
      const trailing = stack.length - i === 5;
      if (!this.open) this.move(0, 0);
      let c1x: number;
      let c1y: number;
      let c2x: number;
      let c2y: number;
      let nx: number;
      let ny: number;
      if (horizontal) {
        c1x = this.x + stack[i];
        c1y = this.y;
        c2x = c1x + stack[i + 1];
        c2y = c1y + stack[i + 2];
        nx = c2x + (trailing ? stack[i + 4] : 0);
        ny = c2y + stack[i + 3];
      } else {
        c1x = this.x;
        c1y = this.y + stack[i];
        c2x = c1x + stack[i + 1];
        c2y = c1y + stack[i + 2];
        nx = c2x + stack[i + 3];
        ny = c2y + (trailing ? stack[i + 4] : 0);
      }
      this.x = nx;
      this.y = ny;
      this.commands.push({ type: "C", c1x, c1y, c2x, c2y, x: nx, y: ny });
      i += trailing ? 5 : 4;
      horizontal = !horizontal;
    }
    this.stack.length = 0;
  }

  private callSubroutine(index: CffIndex | null, depth: number): void {
    const operand = this.stack.pop();
    if (operand === undefined || !index || index.count === 0) return;
    const at = operand + subroutineBias(index.count);
    if (at < 0 || at >= index.count) return;
    this.run(index.offsetAt(at), index.offsetAt(at + 1), depth + 1);
  }

  private escape(at: number): number {
    const b1 = this.view.getUint8(at++);
    switch (b1) {
      case 34: // hflex
        this.flex(true);
        break;
      case 35: // flex
        this.flex(false);
        break;
      case 36: // hflex1
        this.flex1(true);
        break;
      case 37: // flex1
        this.flex1(false);
        break;
      default:
        this.stack.length = 0;
        break;
    }
    return at;
  }

  private flex(horizontal: boolean): void {
    const stack = this.stack;
    if (horizontal && stack.length >= 7) {
      const startY = this.y;
      const c1x = this.x + stack[0];
      const c1y = this.y;
      const c2x = c1x + stack[1];
      const c2y = c1y + stack[2];
      const mx = c2x + stack[3];
      const my = c2y;
      this.commands.push({ type: "C", c1x, c1y, c2x, c2y, x: mx, y: my });
      const d1x = mx + stack[4];
      const d1y = my;
      const d2x = d1x + stack[5];
      const d2y = d1y;
      const ex = d2x + stack[6];
      this.commands.push({ type: "C", c1x: d1x, c1y: d1y, c2x: d2x, c2y: d2y, x: ex, y: startY });
      this.x = ex;
      this.y = startY;
    } else {
      for (let i = 0; i + 5 < stack.length; i += 6) this.curveFrom(stack, i);
    }
    this.stack.length = 0;
  }

  private flex1(horizontal: boolean): void {
    const stack = this.stack;
    if (horizontal && stack.length >= 9) {
      const startX = this.x;
      const startY = this.y;
      const c1x = this.x + stack[0];
      const c1y = this.y + stack[1];
      const c2x = c1x + stack[2];
      const c2y = c1y + stack[3];
      const mx = c2x + stack[4];
      const my = c2y;
      this.commands.push({ type: "C", c1x, c1y, c2x, c2y, x: mx, y: my });
      const d1x = mx + stack[5];
      const d1y = my;
      const d2x = d1x + stack[6];
      const d2y = d1y + stack[7];
      const ex = d2x + stack[8];
      this.commands.push({ type: "C", c1x: d1x, c1y: d1y, c2x: d2x, c2y: d2y, x: ex, y: startY });
      this.x = ex;
      this.y = startY;
    } else {
      this.flex(false);
      return;
    }
    this.stack.length = 0;
  }
}

function subroutineBias(count: number): number {
  if (count < 1240) return 107;
  if (count < 33900) return 1131;
  return 32768;
}

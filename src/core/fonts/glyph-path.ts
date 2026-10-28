/**
 * One glyph's outline as path commands, in font units.
 *
 * The two outline formats a font can carry disagree about curves: `glyf` is
 * quadratic, CFF is cubic. Commands rather than a point list is what lets both
 * feed the same placement code — a cubic carries two control points and cannot
 * be squeezed into a "point with an on-curve flag" without dropping one.
 */

export type GlyphCommand =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | { type: "Q"; cx: number; cy: number; x: number; y: number }
  | { type: "C"; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { type: "Z" };

export type PointMap = (x: number, y: number) => readonly [number, number];

export function transformCommands(commands: GlyphCommand[], map: PointMap): GlyphCommand[] {
  return commands.map((command) => {
    switch (command.type) {
      case "M":
      case "L": {
        const [x, y] = map(command.x, command.y);
        return { type: command.type, x, y };
      }
      case "Q": {
        const [cx, cy] = map(command.cx, command.cy);
        const [x, y] = map(command.x, command.y);
        return { type: "Q", cx, cy, x, y };
      }
      case "C": {
        const [c1x, c1y] = map(command.c1x, command.c1y);
        const [c2x, c2y] = map(command.c2x, command.c2y);
        const [x, y] = map(command.x, command.y);
        return { type: "C", c1x, c1y, c2x, c2y, x, y };
      }
      default:
        return command;
    }
  });
}

export function commandsToPathData(commands: GlyphCommand[]): string {
  const out: string[] = [];
  for (const command of commands) {
    switch (command.type) {
      case "M":
        out.push(`M${fmt(command.x)} ${fmt(command.y)}`);
        break;
      case "L":
        out.push(`L${fmt(command.x)} ${fmt(command.y)}`);
        break;
      case "Q":
        out.push(`Q${fmt(command.cx)} ${fmt(command.cy)} ${fmt(command.x)} ${fmt(command.y)}`);
        break;
      case "C":
        out.push(
          `C${fmt(command.c1x)} ${fmt(command.c1y)} ${fmt(command.c2x)} ${fmt(command.c2y)} ${fmt(
            command.x
          )} ${fmt(command.y)}`
        );
        break;
      case "Z":
        out.push("Z");
        break;
    }
  }
  return out.join("");
}

export interface CommandsBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Control points are included: a caller using this to normalise an origin only
 * needs the box to be an upper bound, and the true extrema cost more than the
 * few units of slack. */
export function commandsBounds(commands: GlyphCommand[]): CommandsBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const note = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const command of commands) {
    switch (command.type) {
      case "M":
      case "L":
        note(command.x, command.y);
        break;
      case "Q":
        note(command.cx, command.cy);
        note(command.x, command.y);
        break;
      case "C":
        note(command.c1x, command.c1y);
        note(command.c2x, command.c2y);
        note(command.x, command.y);
        break;
    }
  }

  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

const fmt = (value: number): string => String(Math.round(value * 100) / 100);

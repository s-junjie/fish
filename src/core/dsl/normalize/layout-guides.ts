import type { LayoutGuide, LayoutGuideAlign, LayoutGuideKind } from "../types";
import { DEFAULT_GUIDE_COLOR } from "../../layout/layout-guides";
import { asBoolean, isPlainObject, type NormalizationRepair } from "./shared";

/**
 * The guide array on a frame, coerced field by field.
 *
 * One bad field costs that field, not the guide: a colour typo must not silently
 * delete the five-column ruler the author was working against. Two fields ARE
 * load-bearing (`count` and `size`) — without them there is nothing to draw — and
 * those refuse the whole entry, with a repair, rather than leaving a ruler that
 * renders as nothing and reads as "there were no guides here".
 */

const KINDS: readonly string[] = ["columns", "rows", "grid"];
const ALIGNS: readonly string[] = ["start", "center", "end", "stretch"];
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A length in px: absent is 0, and 0 is what a refused value falls back to. */
function px(value: unknown, label: string, at: string, repairs: NormalizationRepair[]): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    repairs.push({
      kind: "dropped-property",
      path: `${at}/${label}`,
      message: `layout guide ${label} ${JSON.stringify(value)} is not a number; 0 used`
    });
    return 0;
  }
  if (value < 0) {
    repairs.push({
      kind: "dropped-property",
      path: `${at}/${label}`,
      message: `layout guide ${label} ${value} is negative; 0 used`
    });
    return 0;
  }
  return value;
}

export function normalizeLayoutGuides(
  el: Record<string, unknown>,
  path: string,
  repairs: NormalizationRepair[]
): LayoutGuide[] | undefined {
  const raw = el.layoutGuides ?? el["layout-guides"];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    repairs.push({
      kind: "dropped-property",
      path: `${path}/layoutGuides`,
      message: `layoutGuides must be an array, got ${JSON.stringify(raw)}; dropped`
    });
    return undefined;
  }

  const guides: LayoutGuide[] = [];
  raw.forEach((entry, index) => {
    const at = `${path}/layoutGuides/${index}`;
    if (!isPlainObject(entry)) {
      repairs.push({
        kind: "dropped-property",
        path: at,
        message: `layout guide ${JSON.stringify(entry)} is not an object; dropped`
      });
      return;
    }

    const kind = String(entry.kind);
    if (!KINDS.includes(kind)) {
      repairs.push({
        kind: "dropped-property",
        path: `${at}/kind`,
        message: `layout guide kind ${JSON.stringify(entry.kind)} is not columns, rows or grid; dropped`
      });
      return;
    }

    const guide: LayoutGuide = { kind: kind as LayoutGuideKind };

    if (kind === "grid") {
      const size = px(entry.size, "size", at, repairs);
      if (size <= 0) {
        repairs.push({
          kind: "dropped-property",
          path: `${at}/size`,
          message: `grid guide size ${JSON.stringify(entry.size)} draws nothing; dropped`
        });
        return;
      }
      guide.size = size;
    } else {
      const count = entry.count;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 1 || Math.floor(count) !== count) {
        repairs.push({
          kind: "dropped-property",
          path: `${at}/count`,
          message: `${kind} guide count ${JSON.stringify(count)} is not a whole number of bands; dropped`
        });
        return;
      }
      guide.count = count;

      const gutter = px(entry.gutter, "gutter", at, repairs);
      if (gutter > 0) guide.gutter = gutter;
      const margin = px(entry.margin, "margin", at, repairs);
      if (margin > 0) guide.margin = margin;

      // An unknown alignment falls back to the one every author means by default
      // rather than dropping the guide: the bands are still where they expected.
      if (entry.align !== undefined) {
        if (ALIGNS.includes(String(entry.align))) guide.align = String(entry.align) as LayoutGuideAlign;
        else {
          repairs.push({
            kind: "dropped-property",
            path: `${at}/align`,
            message: `layout guide align ${JSON.stringify(entry.align)} is not start, center, end or stretch; stretch used`
          });
        }
      }

      // A fixed-size set with no size is the one combination with nothing to
      // draw — `stretch` is the only alignment that takes its size from the box.
      if ((guide.align ?? "stretch") !== "stretch") {
        const fixed = px(kind === "columns" ? entry.width : entry.height, kind === "columns" ? "width" : "height", at, repairs);
        if (fixed <= 0) {
          repairs.push({
            kind: "dropped-property",
            path: `${at}/${kind === "columns" ? "width" : "height"}`,
            message: `${kind} guide aligned "${guide.align}" has no size; dropped`
          });
          return;
        }
        if (kind === "columns") guide.width = fixed;
        else guide.height = fixed;
      }
    }

    if (typeof entry.color === "string" && HEX.test(entry.color.trim())) guide.color = entry.color.trim();
    else if (entry.color !== undefined) {
      repairs.push({
        kind: "dropped-property",
        path: `${at}/color`,
        message: `layout guide colour ${JSON.stringify(entry.color)} is not #RGB/#RGBA/#RRGGBB/#RRGGBBAA; ${DEFAULT_GUIDE_COLOR} used`
      });
    }

    if (asBoolean(entry.visible) === false) guide.visible = false;
    guides.push(guide);
  });

  return guides;
}

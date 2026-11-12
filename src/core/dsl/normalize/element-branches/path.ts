import { normalizeFillStack } from "../paint";
import { normalizeStrokes } from "../stroke";
import type { ElementBranch } from "./shared";
import { isPlainObject, pxLength } from "../shared";
import { parsePathData, serializePathData, type EditablePath, type Pt } from "../../../geometry/path-data";

const FILL_RULES: readonly string[] = ["nonzero", "evenodd"];

type ViewBox = { x: number; y: number; width: number; height: number };

/** `viewBox` as SVG writes it: `"0 0 24 24"`, a four-number array, or an object. */
function readViewBox(raw: unknown): ViewBox | undefined {
  const fromNumbers = (values: unknown): ViewBox | undefined => {
    if (!Array.isArray(values) || values.length !== 4) return undefined;
    const [x, y, width, height] = values.map(Number);
    return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : undefined;
  };
  if (typeof raw === "string") {
    const parts = raw.trim().split(/[\s,]+/);
    return parts.length === 4 ? fromNumbers(parts) : undefined;
  }
  if (Array.isArray(raw)) return fromNumbers(raw);
  if (isPlainObject(raw)) {
    const o = raw as Record<string, unknown>;
    return fromNumbers([o.x, o.y, o.width ?? o.w, o.height ?? o.h]);
  }
  return undefined;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Bake a `viewBox` into the path's own coordinates.
 *
 * Unlike an SVG `<svg viewBox>`, a `path` element's `d` is drawn exactly as
 * written — `width`/`height` are its box, not a scale — so an icon copied from a
 * library at 24×24 landed tiny in a 48px box with nothing said. The box is the
 * target; without one the viewBox's own extent is the target, so the path keeps
 * its natural size.
 */
function bakeViewBox(d: string, box: ViewBox, width: number, height: number): string | undefined {
  const parsed = parsePathData(d);
  if (!parsed) return undefined;
  const sx = width / box.width;
  const sy = height / box.height;
  const map = (p: Pt): Pt => ({ x: round2((p.x - box.x) * sx), y: round2((p.y - box.y) * sy) });
  const baked: EditablePath = {
    closed: parsed.closed,
    anchors: parsed.anchors.map((a) => ({ ...map(a), ...(a.m ? { m: true as const } : {}) })),
    segments: parsed.segments.map((s) =>
      s.kind === "line" ? s : s.kind === "quad" ? { ...s, c: map(s.c) } : { ...s, ca: map(s.ca), cb: map(s.cb) }
    )
  };
  return serializePathData(baked);
}

export const normalizePath: ElementBranch = ({ el, base, path, repairs }) => {
  // SVG path data; `path` / `pathData` are common alternative spellings.
  const d =
    (typeof el.d === "string" && el.d.trim()) ||
    (typeof el.pathData === "string" && el.pathData.trim()) ||
    (typeof el.path === "string" && el.path.trim()) ||
    undefined;
  if (d) {
    base.d = d;
  } else {
    // A path without data draws nothing; keep the element but say why.
    base.d = "";
    repairs.push({ kind: "element", path: `${path}/d`, severity: "info", message: 'path had no "d" data; renders nothing' });
  }

  if (typeof base.d === "string" && base.d && el.viewBox !== undefined) {
    const box = readViewBox(el.viewBox);
    if (!box || !(box.width > 0) || !(box.height > 0)) {
      repairs.push({
        kind: "element",
        path: `${path}/viewBox`,
        message: `viewBox ${JSON.stringify(el.viewBox)} is not four numbers with a positive size; ignored`
      });
    } else {
      const width = pxLength(el.width) ?? box.width;
      const height = pxLength(el.height) ?? box.height;
      const baked = bakeViewBox(base.d, box, width, height);
      if (baked) {
        base.d = baked;
        // The box IS the target the viewBox was baked against, so an axis the
        // author omitted has to be written down. `base` was initialised from
        // `pxLength(el.width)` and kept 0, which left a 24×24 drawing inside a
        // 0×0 element: nothing painted, and `check --geometry` called it
        // zero-size in a document that looked authored.
        base.width = round2(width);
        base.height = round2(height);
        repairs.push({
          kind: "element",
          path: `${path}/viewBox`,
          severity: "info",
          message: `viewBox ${JSON.stringify(el.viewBox)} baked into "d" at ${round2(width)}×${round2(height)}`
        });
      }
    }
  }

  const fills = normalizeFillStack(el, path, repairs);
  if (fills && fills.length > 0) base.fills = fills;
  // No fill backfill: a stroke-only path (outline icon) is a legitimate
  // primary use of the type, unlike a fill-less rect which is a mistake.

  const strokes = normalizeStrokes(el, path, repairs);
  if (strokes) base.strokes = strokes;

  // No backfill of "nonzero": an absent key already means that, so writing
  // it would put a paint rule on every path in every document. Only a value
  // that changes the rendering is worth storing.
  // `fill-rule` is the spelling the file uses; `fillRule` is still read so an
  // existing document is not dropped for being old. The gate already accepted
  // the kebab form — `canonicalKey` folds it onto `fillRule` — so without a
  // reader here it was accepted and then silently discarded.
  const fillRuleRaw = el.fillRule ?? el["fill-rule"];
  if (typeof fillRuleRaw === "string" && FILL_RULES.includes(fillRuleRaw)) {
    base.fillRule = fillRuleRaw as "nonzero" | "evenodd";
  } else if (fillRuleRaw !== undefined && fillRuleRaw !== "nonzero") {
    repairs.push({
      kind: "element",
      path: `${path}/fill-rule`,
      message: `unknown fill rule "${fillRuleRaw}" dropped (expected one of: ${FILL_RULES.join(", ")})`
    });
  }
};

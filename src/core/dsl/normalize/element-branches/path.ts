import { normalizeFillStack } from "../paint";
import { normalizeStrokes } from "../stroke";
import type { ElementBranch } from "./shared";

const FILL_RULES: readonly string[] = ["nonzero", "evenodd"];

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

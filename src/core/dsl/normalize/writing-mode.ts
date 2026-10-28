/**
 * CSS `writing-mode`, folded onto the geometry a vertical line already is.
 *
 * The DSL has no vertical-text field: a vertical line is a horizontal box turned
 * a quarter turn, which is exactly what `rotation` says. So a sidebar label
 * authored as `writing-mode: vertical-rl` is stored as `rotation: 90` with the
 * box's axes swapped about its centre — the same representation the HTML
 * importer writes, so both paths produce one editable text element.
 *
 * One turn cannot reproduce type the browser keeps UPRIGHT and merely stacks
 * (`text-orientation: upright`, or upright-only scripts under the default
 * `mixed`), so those are reported rather than turned sideways.
 */

import { NormalizationRepair } from "./shared";

/** Scripts a vertical line sets upright instead of turning sideways. */
const UPRIGHT_SCRIPTS = /[\u1100-\u11ff\u2e80-\u303f\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97c\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6b\uff01-\uff60\uffe0-\uffe6]/;

const SIDEWAYS: ReadonlySet<string> = new Set(["vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr"]);

const ORIENTATIONS: ReadonlySet<string> = new Set(["mixed", "upright", "sideways"]);

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** A text element's string, whichever spelling the author used. */
function textOf(el: Record<string, unknown>): string {
  for (const key of ["content", "text", "characters"]) {
    const value = el[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Fold an authored `writing-mode` onto `base`, which already holds geometry and
 * any absorbed transform rotation.
 *
 * The box is swapped around its centre because that point a turn leaves fixed:
 * `rotation` turns the stored box about its own centre, so a 12×240 column
 * becomes a 240×12 line at the SAME centre, turned 90°.
 */
export function absorbWritingMode(
  el: Record<string, unknown>,
  base: Record<string, unknown>,
  type: string,
  path: string,
  repairs: NormalizationRepair[]
): void {
  const field = `${path}/writing-mode`;
  const rawMode = el["writing-mode"];
  const rawOrientation = el["text-orientation"];
  const mode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : undefined;
  const sided = mode !== undefined && SIDEWAYS.has(mode);

  // `text-orientation` only means something in a vertical line, and only its
  // `upright` value changes the representation (it is the one a turn cannot
  // hold). A value outside the vocabulary is reported rather than guessed at.
  let upright = false;
  if (rawOrientation !== undefined) {
    const orientation = typeof rawOrientation === "string" ? rawOrientation.trim().toLowerCase() : "";
    if (!ORIENTATIONS.has(orientation)) {
      repairs.push({
        kind: "dropped-property",
        path: `${path}/text-orientation`,
        message: `text-orientation ${JSON.stringify(rawOrientation)} is not a writing-mode value`
      });
    } else if (!sided || orientation !== "upright") {
      if (!sided) {
        repairs.push({
          kind: "dropped-property",
          path: `${path}/text-orientation`,
          message: `text-orientation "${orientation}" has no effect without a vertical writing-mode`
        });
      }
    } else {
      upright = true;
    }
  }

  if (rawMode === undefined) return;
  if (typeof rawMode !== "string") {
    repairs.push({ kind: "dropped-property", path: field, message: `writing-mode ${JSON.stringify(rawMode)} is not a string` });
    return;
  }
  const modeValue = rawMode.trim();
  if (!modeValue || modeValue === "horizontal-tb" || modeValue === "tb") return;
  if (!sided) {
    repairs.push({ kind: "dropped-property", path: field, message: `writing-mode "${rawMode}" is not supported` });
    return;
  }
  if (type !== "text") {
    repairs.push({
      kind: "dropped-property",
      path: field,
      message: `writing-mode "${rawMode}" has no field on a ${type}; vertical line layout is only read on text elements`
    });
    return;
  }
  if (upright || UPRIGHT_SCRIPTS.test(textOf(el))) {
    repairs.push({
      kind: "dropped-property",
      path: field,
      message: `writing-mode "${rawMode}" sets upright glyphs; the DSL can only turn a line sideways, so upright vertical text is not reproduced`
    });
    return;
  }

  const width = typeof base.width === "number" ? base.width : 0;
  const height = typeof base.height === "number" ? base.height : 0;
  const cx = (typeof base.x === "number" ? base.x : 0) + width / 2;
  const cy = (typeof base.y === "number" ? base.y : 0) + height / 2;
  base.x = round(cx - height / 2);
  base.y = round(cy - width / 2);
  base.width = height;
  base.height = width;

  const rotation = round((typeof base.rotation === "number" ? base.rotation : 0) + 90);
  base.rotation = rotation;
  repairs.push({
    kind: "element",
    path: field,
    severity: "info",
    message: `writing-mode "${rawMode}" absorbed as rotation ${rotation} with the box's axes swapped`
  });
}

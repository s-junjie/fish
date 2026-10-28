import type { Paint, Stroke, TextStyleDeclaration } from "../../core/dsl/types";
import { DEFAULT_ELEMENT_COLOR } from "../../core/dsl/defaults";
import { DEFAULT_FONT_FAMILY } from "../../core/font-stack";

/**
 * The drafts a NEW style starts from.
 *
 * Both defaults used to be `#000000`, which is the document's default TEXT
 * colour and correct on a white artboard — and invisible here: the style editor
 * draws its preview on `panel` (#181818), so a new colour style showed an empty
 * checkerboard and a new text style showed nothing at all. Editing an existing
 * style looked fine, which is exactly why the bug survived: the defaults are
 * only ever seen in the create path.
 *
 * `DEFAULT_ELEMENT_COLOR` (#D9D9D9) is the app's own element colour and measures
 * 12.4:1 on `panel`, so the first thing a user sees is the thing they are about
 * to change. Both live here so the "+ add a layer" button in the editor seeds
 * the same value as the editor's initial draft.
 */
export const NEW_SOLID: Paint = { type: "solid", color: DEFAULT_ELEMENT_COLOR };

/** Type only, no ink: a text style carries no colour (see `TextStyleDeclaration`). */
export const DEFAULT_TEXT_STYLE: TextStyleDeclaration = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 16,
  fontWeight: 400
};

export const DEFAULT_STROKE_ROW: Stroke = {
  color: DEFAULT_ELEMENT_COLOR,
  width: 1,
  align: "inside",
  enabled: true
};
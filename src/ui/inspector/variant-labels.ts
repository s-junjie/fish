import { t } from "../../i18n";
import type { VariantLabels } from "../../core/interactions/component-variants";

/**
 * Figma's generated variant names, localized.
 *
 * The algorithms that pick them live in `core/interactions/variant-naming.ts` and
 * take these as arguments, because `i18n` is a UI dependency and the model must not
 * have one (AGENTS.md §4). This is the only place the two meet.
 *
 * `Default` and `Variant 2` are Figma's exact defaults and they read as odd on
 * purpose: a visibly generic name is a label asking to be replaced.
 *
 * `Property 1` was Figma's default too, and it was the one that read as a bug
 * here: the FIRST generated property is not "property one of several", it is
 * just the property, and the `1` in a 288px panel looked like a variant count
 * that had lost its row. So the first one is `Property` and the numbering only
 * starts when there is something to number.
 */
export const VARIANT_LABELS: VariantLabels = {
  property: (n) => (n === 1 ? t("component.property") : t("component.propertyN", { n })),
  firstValue: t("component.defaultValue"),
  nthValue: (n) => t("component.variantN", { n })
};

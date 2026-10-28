import type { DesignDocument } from "../dsl/types";
import {
  addVariant,
  addVariantProperty,
  addVariantPropertyToSet,
  setVariantValue,
  type VariantLabels
} from "../interactions/component-variants";
import { str, type OpOutcome } from "./op-primitives";

/**
 * The two variant intents, in the order Figma reaches for them.
 *
 * `make-variant` was in the intent table long before any of it worked, and it keeps
 * its name and its meaning: give one component a coordinate, creating the set and
 * the property if they are not there yet. That is the form an agent wants, because
 * it can state the answer without knowing what already exists.
 *
 * `add-variant` is Figma's own "Add variant" and is a different operation rather
 * than a convenience: a copy of the selected member below it in the set, carrying
 * the next value nobody has used. It takes a property to differ on and nothing
 * else — the value is generated, exactly as Figma generates it.
 */
export function applyComponentIntent(
  doc: DesignDocument,
  op: string,
  targetId: string | undefined,
  raw: Record<string, unknown>
): { doc: DesignDocument; outcome: Omit<OpOutcome, "index"> } | null {
  if (op !== "make-variant" && op !== "add-variant") return null;
  if (!targetId) {
    return { doc, outcome: { op, ok: false, detail: `${op} needs \`targetId\`` } };
  }

  if (op === "add-variant") {
    const added = addVariant(doc, targetId, SCRIPT_VARIANT_LABELS, str(raw.property));
    if (!added.variant) {
      return {
        doc,
        outcome: {
          op,
          ok: false,
          detail: `"${targetId}" is not a variant of a set, or its set declares no properties`,
          id: targetId
        }
      };
    }
    return {
      doc: added.doc,
      outcome: {
        op,
        ok: true,
        detail: `added variant ${added.variant.name}`,
        id: added.variant.id
      }
    };
  }

  const property = str(raw.property) ?? str(raw.axis);
  const value = str(raw.value);
  if (!property || !value) {
    return {
      doc,
      outcome: { op, ok: false, detail: "make-variant needs `property` and `value`", id: targetId }
    };
  }
  // A lone main component becomes a one-member set on the way in, with the
  // property created if the set has none — otherwise "make this a variant with
  // State=Hover" would be impossible to express for a component that has never
  // been in a set.
  const ensured = addVariantProperty(doc, targetId, SCRIPT_VARIANT_LABELS, property);
  if (!ensured.set) {
    return {
      doc,
      outcome: { op, ok: false, detail: `"${targetId}" is not a component`, id: targetId }
    };
  }
  const named = ensured.property === property
    ? ensured.doc
    : addVariantPropertyToSet(ensured.doc, ensured.set.id, SCRIPT_VARIANT_LABELS, property).doc;
  const next = setVariantValue(named, ensured.set.id, targetId, property, value);
  if (!next) {
    return { doc, outcome: { op, ok: false, detail: `could not set ${property}=${value}`, id: targetId } };
  }
  return { doc: next, outcome: { op, ok: true, detail: `set variant ${property}=${value}`, id: targetId } };
}

/**
 * Figma's generated names, in English, for the scripted surface.
 *
 * The UI passes the editor's locale through `VariantLabels`; an op's argument
 * vocabulary does not, because a document written by one script is read by another
 * and Figma's `Property 1` / `Default` are not translated there either.
 */
const SCRIPT_VARIANT_LABELS: VariantLabels = {
  property: (n) => `Property ${n}`,
  firstValue: "Default",
  nthValue: (n) => `Variant ${n}`
};

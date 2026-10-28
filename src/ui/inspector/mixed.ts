import { DesignElement } from "../../core/dsl/types";

/**
 * One value across a selection, or the fact that there is not one.
 *
 * The panel reads a single element, so a five-layer selection showed the primary's
 * number in every field with nothing saying the other four disagreed. That is the
 * worst of the three available answers: it is not "here is a value you may edit",
 * and it is not "these differ", it is a specific layer's value in a control that
 * edits all five. A field has to be able to say *I don't know*.
 */
export interface Resolved<T> {
  /** The shared value. The FIRST element's when mixed — never rendered, but it is
   *  what a drag or an arrow key would start from if one were ever allowed to. */
  value: T;
  mixed: boolean;
}

/**
 * What a field shows when the selection disagrees.
 *
 * **Not translated, deliberately.** It is not a label for a thing the panel does —
 * it is the absence of a value, and it stands in a field's own grammar beside the
 * `auto` a size mode writes when the container owns the number (`ScrubInput`
 * treats `auto` the same way, untranslated). A word that has to be translated to
 * mean "none of these agree" is a word whose translation can end up meaning
 * something else entirely, and this one has no meaning without the empty field it
 * sits in.
 */
export const MIXED_LABEL = "Mixed";

/**
 * The shared value of `pick` across `elements`, and whether they agree.
 *
 * `undefined` counts as a value of its own: a selection where one layer stores a
 * corner radius and another stores none is a selection whose corner radius differs,
 * and collapsing the absent one to `0` would report a field that is set.
 *
 * Single selections are never mixed — the comparison has nothing to compare.
 */
export function resolveAcross<T>(
  elements: readonly DesignElement[],
  pick: (el: DesignElement) => T
): Resolved<T> {
  if (elements.length === 0) return { value: undefined as unknown as T, mixed: false };
  const first = pick(elements[0]);
  for (let i = 1; i < elements.length; i++) {
    if (!Object.is(pick(elements[i]), first)) return { value: first, mixed: true };
  }
  return { value: first, mixed: false };
}

/**
 * The same, over plain values rather than elements — for a property several
 * layers express through different fields (`resolveAxis` answers one shape for a
 * frame and another for a leaf).
 */
export function resolveValues<T>(values: readonly T[]): Resolved<T> {
  const first = values[0];
  for (let i = 1; i < values.length; i++) {
    if (!Object.is(values[i], first)) return { value: first, mixed: true };
  }
  return { value: first, mixed: false };
}
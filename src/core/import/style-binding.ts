import { bindEffectStyle, bindFillStyle } from "../interactions/style-ops";
import { mapElements } from "../geometry/tree-ops";
import type { DesignElement, DesignStyle, EffectStyle, Paint, PaintStyle } from "../dsl/types";

export interface StyleBindings {
  elements: DesignElement[];
  bound: number;
}

/**
 * Whether this paint already names a token — its own, or one of its gradient
 * stops'. Either is a binding a style must not overwrite.
 */
const followsToken = (paint: Paint | undefined): boolean => {
  if (!paint) return false;
  if (paint.tokenId) return true;
  const stops = "stops" in paint ? paint.stops : undefined;
  return (stops ?? []).some((stop) => stop.tokenId);
};

/**
 * Attach imported paint to the document's own styles, by value.
 *
 * An import lands raw colours; a document that already has a palette would
 * otherwise end up with a page of one-off values that merely look like the
 * tokens. Matching is by VALUE rather than by CSS custom-property name, because
 * a token's name is gone by the time the browser reports a computed colour —
 * `var(--panel)` and a literal `#101014` are the same string, and the value is
 * the only thing left to match on.
 *
 * The three axes bind through `style-ops`' own `bind*Style` rather than by
 * writing the id here: those are what keep `fills`/`strokes`/`effects` in step
 * with the style they name, and a binding written past them is one the next
 * `syncDualStorage` reads as drift. A style is only accepted when applying it
 * changes nothing, which is the whole meaning of "by value".
 *
 * Text styles are deliberately NOT matched: every renderer reads a text
 * element's `style` directly and nothing resolves `textStyleId` on the canvas,
 * so a binding there would be a library link the canvas does not honour.
 */
export function bindStylesByValue(elements: DesignElement[], styles: readonly DesignStyle[]): StyleBindings {
  const paintStyles = styles.filter((s): s is PaintStyle => s.styleType === "paint" && Array.isArray(s.paints));
  const effectStyles = styles.filter((s): s is EffectStyle => s.styleType === "effect" && Array.isArray(s.effects));
  if (paintStyles.length === 0 && effectStyles.length === 0) return { elements, bound: 0 };

  const fillMatch = indexBy(paintStyles, (s) => key(s.paints));
  const effectMatch = indexBy(effectStyles, (s) => key(s.effects));

  let bound = 0;
  const out = mapElements(elements, (el) => {
    let next = el;

    /* A layer the page wrote as `var(--x)` already carries the token it named.
       Matching it to a style by VALUE would add a second binding to the same
       layer, and the two would then disagree the moment either one is edited —
       so an axis that is token-bound is left alone. The same goes for an axis
       that already arrived with a style id: value matching cannot see WHICH
       style it was, and overwriting the link with one that happens to hold the
       same colour is a binding the designer never made. */
    const fill =
      Array.isArray(next.fills) && next.fills.length > 0 && !next.fillStyleId && !next.fills.some(followsToken)
        ? fillMatch.get(key(next.fills))
        : undefined;
    if (fill && key(bindFillStyle(next, fill).fills) === key(next.fills)) {
      next = bindFillStyle(next, fill);
      bound++;
    }

    const effect =
      Array.isArray(next.effects) &&
      next.effects.length > 0 &&
      !next.effectStyleId &&
      !next.effects.some((row) => (row as { tokenId?: string }).tokenId)
        ? effectMatch.get(key(next.effects))
        : undefined;
    if (effect) {
      const applied = bindEffectStyle(next, effect);
      if (key(applied.effects) === key(next.effects)) {
        next = applied;
        bound++;
      }
    }

    return next;
  });

  return { elements: out, bound };
}

function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  // First writer wins, so the document's own order decides between two styles
  // that hold the same value — an arbitrary pick would move a user's binding
  // between sessions.
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, item);
  }
  return map;
}

/**
 * A value comparison that survives key order and absent-vs-undefined, so a
 * style authored by hand and the same paint computed from CSS are one key.
 */
function key(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(key).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const name of Object.keys(record).sort()) {
    if (record[name] === undefined) continue;
    parts.push(`${JSON.stringify(name)}:${key(record[name])}`);
  }
  return `{${parts.join(",")}}`;
}

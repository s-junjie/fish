/**
 * Swap one font family for another everywhere the document names it.
 *
 * A missing family is a claim the file cannot keep, and every fix for it is the
 * same operation: rewrite the names. Three places hold one — a text layer's own
 * `style.fontFamily`, the `style.fontFamily` of each of its runs, and a text
 * style in `doc.styles[]`. Missing any one of them leaves a family that reports
 * itself missing on the next scan while the canvas shows the replacement, which
 * is a file that can never be made clean.
 *
 * The two scopes are Figma's: this SELECTION (the layers the author is looking
 * at) or the whole document (which is the only scope that also rewrites the
 * shared style table).
 */

import type { DesignDocument, DesignElement, TextElement, TextStyleDefinition } from "../dsl/types";
import { declaresFallback, firstNamedFamily } from "../font-stack";
import { mapElements } from "../geometry/tree-edit";
import { relayoutDocumentTree } from "../layout/auto-layout";
import { instanceSizeResolver } from "./instance-size";

export type FontReplaceScope = "document" | { readonly elementIds: ReadonlySet<string> };

const keyOf = (family: string | undefined | null): string => firstNamedFamily(family ?? "").toLowerCase();

/**
 * Whether a stored stack is a claim on `from`.
 *
 * A stack that declares its own fallback is left alone on purpose: `"Inter,
 * sans-serif"` says out loud what a substitution should look like, so that
 * layer is already painting by design and is not part of the problem. It is also
 * never reported `missing` (same predicate), so replacing it would edit layers
 * the author never asked about.
 */
function claims(family: string | undefined, fromKey: string): boolean {
  return Boolean(family) && keyOf(family) === fromKey && !declaresFallback(family!);
}

export function replaceFontFamily(
  doc: DesignDocument,
  from: string,
  to: string,
  scope: FontReplaceScope
): DesignDocument {
  const fromKey = keyOf(from);
  if (!fromKey || !to.trim()) return doc;
  const selection = scope === "document" ? null : scope.elementIds;
  let touched = false;

  const replacedPages = (doc.pages ?? []).map((page) => {
    const children = mapElements(page.children ?? [], (el) => {
      if (el.type !== "text") return el;
      if (selection && !selection.has(el.id)) return el;
      const text = el as TextElement;

      const style = claims(text.style?.fontFamily, fromKey)
        ? { ...text.style, fontFamily: to }
        : text.style;
      const spans = text.spans?.length
        ? text.spans.map((span) =>
            claims(span.style?.fontFamily, fromKey)
              ? { ...span, style: { ...span.style, fontFamily: to } }
              : span
          )
        : text.spans;
      const spansChanged = spans !== text.spans;
      if (style === text.style && !spansChanged) return el;

      const nextEl: TextElement = { ...text, ...(style ? { style } : {}), ...(spans ? { spans } : {}) };
      // A layer bound to a text STYLE re-materialises its whole `style` from that
      // style on the next cascade, so a family written here alone would be gone
      // by the next commit. Replacing on the SELECTION therefore detaches the
      // layer — that is what "this layer, in the new font" has to mean when the
      // font comes from a shared style. The document scope rewrites the style
      // itself, and the binding survives.
      if (selection) delete (nextEl as { textStyleId?: string }).textStyleId;
      return nextEl;
    });
    const changed = children !== page.children;
    if (changed) touched = true;
    return { page, children, changed };
  });

  const styles = selection
    ? doc.styles
    : doc.styles?.map((style) => {
        if (style.styleType !== "text") return style;
        const text = style as TextStyleDefinition;
        if (!claims(text.style?.fontFamily, fromKey)) return style;
        touched = true;
        return { ...text, style: { ...text.style, fontFamily: to } };
      });

  // A carried face for the family that just left the document is dead weight the
  // next export would still embed.
  const fonts = selection ? doc.fonts : doc.fonts?.filter((font) => keyOf(font.family) !== fromKey);

  if (!touched) return doc;
  const next: DesignDocument = {
    ...doc,
    pages: replacedPages.map(({ page, children }) => (page.children === children ? page : { ...page, children }))
  };
  if (styles) next.styles = styles;
  if (fonts !== doc.fonts) {
    // An emptied table is REMOVED, not left as `[]`: the canonical form does not
    // carry a table nobody writes, and a round trip through it has to be an
    // identity (see `syncDocument` in `style-ops`).
    if (fonts && fonts.length > 0) next.fonts = fonts;
    else delete (next as { fonts?: unknown }).fonts;
  }

  // The replacement is normally an installed family, which is what lifts the
  // freeze in `resolveTextSizing`: the box re-measures here, once, instead of
  // being thawed by whichever gesture happens to touch it next. Passing the
  // instanceSizeResolver ensures instances referencing modified master components
  // are updated in the same pass.
  const resolver = instanceSizeResolver(next);
  next.pages = next.pages.map((page, i) => {
    if (!replacedPages[i]?.changed) return page;
    return { ...page, children: relayoutDocumentTree(page.children, resolver) };
  });

  return next;
}

/** The layers a replacement would touch, for a button that says how many. */
export function countFamilyUse(elements: readonly DesignElement[], family: string): number {
  const key = keyOf(family);
  let count = 0;
  const walk = (list: readonly DesignElement[]): void => {
    for (const el of list) {
      if (el.type === "text") {
        const text = el as TextElement;
        const hit =
          claims(text.style?.fontFamily, key) ||
          Boolean(text.spans?.some((span) => claims(span.style?.fontFamily, key)));
        if (hit) count++;
      }
      const children = (el as { children?: DesignElement[] }).children;
      if (children?.length) walk(children);
    }
  };
  walk(elements);
  return count;
}

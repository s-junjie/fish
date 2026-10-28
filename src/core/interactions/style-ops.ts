import {
  DesignDocument,
  DesignElement,
  DesignStyle,
  DesignToken,
  Effect,
  EffectStyle,
  Paint,
  PaintStack,
  PaintStyle,
  Stroke,
  StrokeStyle,
  StyleType,
  TextElement,
  TextStyle,
  TextStyleDeclaration,
  TextStyleDefinition
} from "../dsl/types";
import { topPaint } from "../dsl/paint-stack";
import { toTextStyleDeclaration } from "../dsl/text-style-declarations";
import { mapElements } from "../geometry/tree-ops";
import { relayoutDocumentTree } from "../layout/auto-layout";
import { createId } from "../id";
import {
  cascadeTokensIntoStyles,
  resolvePaintStylePaints,
  syncDualStorage
} from "./style-sync";
import { getActiveNumberMode, getActiveTheme } from "./mode-ops";

export { syncDualStorage };

/**
 * A stroke style declares its rows, and nothing outside itself.
 *
 * The four style kinds are independent: a `StrokeStyle` never names a paint
 * style, a text style never names an effect, and the only bridge between them is
 * a colour/number TOKEN. So a row carries the paint it paints (or the token that
 * paint follows) and no pointer at another style.
 */
export function createStrokeStyle(
  name: string,
  strokes: Stroke[],
  description?: string
): StrokeStyle {
  return {
    id: createId("style_stroke"),
    name: name.trim() || "Untitled Stroke",
    styleType: "stroke",
    strokes: JSON.parse(JSON.stringify(strokes)),
    ...(description ? { description: description.trim() } : {})
  };
}

export function createPaintStyle(
  name: string,
  paints: PaintStack,
  description?: string
): PaintStyle {
  return {
    id: createId("style_paint"),
    name: name.trim() || "Untitled Color",
    styleType: "paint",
    paints: JSON.parse(JSON.stringify(paints)),
    ...(description ? { description: description.trim() } : {})
  };
}

/**
 * A text style is TYPE: the declarations in `TEXT_STYLE_KEYS`, and no more.
 *
 * Callers hand over a whole `TextStyle` — usually a layer's — so everything the
 * style cannot own is cut here as well as in normalize. One cut, one list: the
 * style editor and the layer inspector both read it, so a parameter is never
 * editable in two places at once. There is no effects argument on purpose: a
 * shadow is the layer's, and a style that also carried one repainted it on
 * every sync.
 */
export function createTextStyle(
  name: string,
  style: TextStyle | TextStyleDeclaration,
  description?: string
): TextStyleDefinition {
  const { declaration } = toTextStyleDeclaration(style as TextStyle);
  return {
    id: createId("style_text"),
    name: name.trim() || "Untitled Text",
    styleType: "text",
    style: declaration,
    ...(description ? { description: description.trim() } : {})
  };
}

export function createEffectStyle(
  name: string,
  effects: Effect[],
  description?: string
): EffectStyle {
  return {
    id: createId("style_effect"),
    name: name.trim() || "Untitled Effect",
    styleType: "effect",
    effects: JSON.parse(JSON.stringify(effects)),
    ...(description ? { description: description.trim() } : {})
  };
}

export function addStyleToDoc(doc: DesignDocument, style: DesignStyle): DesignDocument {
  const styles = doc.styles ? [...doc.styles, style] : [style];
  return {
    ...doc,
    styles
  };
}

export function addTokenToDoc(doc: DesignDocument, token: DesignToken): DesignDocument {
  const tokens = doc.tokens ? [...doc.tokens, token] : [token];
  return { ...doc, tokens };
}

/**
 * Copy the two tables' resolved values onto every layer that names them.
 *
 * A token or style whose value changed has already been re-cascaded into the
 * styles before this runs, so the only job left is the layer half of the
 * materialised-value invariant: what a layer shows must equal what its
 * reference resolves to in the current scope.
 */
function syncDocument(
  doc: DesignDocument,
  styles: DesignStyle[],
  tokens: readonly DesignToken[],
  needsRelayout: boolean
): DesignDocument {
  const tables = { styles, tokens };
  const activeTheme = getActiveTheme(doc);
  const activeNumberMode = getActiveNumberMode(doc);

  const updatePages = (doc.pages || []).map((page) => {
    const children = page.children || [];
    let pageChanged = false;
    const updatedElements = children.map((el) => {
      const next = syncDualStorage(el, tables, activeTheme, activeNumberMode);
      if (next !== el) pageChanged = true;
      return next;
    });
    if (!pageChanged) return page;
    const finalElements = needsRelayout ? relayoutDocumentTree(updatedElements) : updatedElements;
    return { ...page, children: finalElements };
  });

  return {
    ...doc,
    // Materialising never invents a table. A document that carries no tokens
    // and no styles must not come back with an empty `tokens` array beside the
    // ones it never had, or a round trip through the canonical form stops
    // being an identity and every reader diffs against a shape it did not write.
    ...(doc.styles || styles.length ? { styles } : {}),
    ...(doc.tokens || tokens.length ? { tokens: tokens as DesignToken[] } : {}),
    pages: updatePages
  };
}

/**
 * Make every binding in the document true, without being told what changed.
 *
 * `normalize` keeps a style id and a token id as references and copies nothing,
 * so a document that was authored rather than edited — by hand, or by an agent
 * through the CLI — carries bindings the renderer cannot read: it paints
 * `el.style` and `el.fills`, and both are empty. Every read path that turns a
 * stored document into a live one goes through here so the reference and the
 * materialised value agree from the first frame.
 *
 * No relayout: this runs before anything is on screen, and a size that depends
 * on the text is computed by the layout pass, not stored here.
 */
export function syncDocumentBindings(doc: DesignDocument): DesignDocument {
  return syncDocument(doc, doc.styles ?? [], doc.tokens ?? [], false);
}

/** Edit a STYLE: re-cascade token values into it, then move the layers that wear it. */
export function updateStyleInDoc(doc: DesignDocument, updated: DesignStyle): DesignDocument {
  const rawStyles = (doc.styles || []).map((s) => (s.id === updated.id ? updated : s));
  const tokens = doc.tokens ?? [];
  const styles = cascadeTokensIntoStyles(rawStyles, tokens, getActiveTheme(doc), undefined, getActiveNumberMode(doc));
  const needsRelayout = updated.styleType === "text";
  return syncDocument(doc, styles, tokens, needsRelayout);
}

/** Edit a TOKEN: cascade its value into every style that follows it, then the layers. */
export function updateTokenInDoc(doc: DesignDocument, token: DesignToken): DesignDocument {
  const rawTokens = doc.tokens ?? [];
  const tokens = rawTokens.some((t) => t.id === token.id)
    ? rawTokens.map((t) => (t.id === token.id ? token : t))
    : [...rawTokens, token];
  const rawStyles = doc.styles ?? [];
  const styles = cascadeTokensIntoStyles(
    rawStyles,
    tokens,
    getActiveTheme(doc),
    token.id,
    getActiveNumberMode(doc)
  );
  const textMoved = styles.some((s, i) => s !== rawStyles[i] && s.styleType === "text");
  return syncDocument(doc, styles, tokens, token.type === "number" || textMoved);
}

/**
 * Delete a STYLE, stripping only the references that name a style.
 *
 * Layers keep the paint or effect they are showing: the value is materialised
 * beside the binding, so dropping the id detaches without changing appearance.
 * A token reference on the same layer is a different table's business and is
 * left alone.
 */
export function removeStyleFromDoc(doc: DesignDocument, styleId: string): DesignDocument {
  const styles = (doc.styles || []).filter((s) => s.id !== styleId);

  const unbindMatching = (el: DesignElement): DesignElement => {
    let changed = false;
    let next = el;

    if (el.fillStyleId === styleId) {
      next = unbindStyleId(next, "fillStyleId");
      changed = true;
    }
    if (el.strokeStyleId === styleId) {
      next = unbindStyleId(next, "strokeStyleId");
      changed = true;
    }
    if (el.effectStyleId === styleId) {
      next = unbindStyleId(next, "effectStyleId");
      changed = true;
    }
    if (el.type === "text" && (el as TextElement).textStyleId === styleId) {
      next = unbindStyleId(next, "textStyleId");
      changed = true;
    }

    return changed ? next : el;
  };

  const updatePages = (doc.pages || []).map((page) => {
    const updatedElements = mapElements(page.children || [], unbindMatching);
    return updatedElements !== page.children ? { ...page, children: updatedElements } : page;
  });

  return {
    ...doc,
    styles,
    pages: updatePages
  };
}

/**
 * Delete a TOKEN, stripping only the references that name a token.
 *
 * Every place a token can be named: a paint's or stroke's `tokenId`, an
 * effect's `tokenId`, and a `tokenBindings` entry on the layer, its text style
 * or its effect. The value stays materialised, so the layer that followed the
 * token keeps the colour or size it was showing.
 */
export function removeTokenFromDoc(doc: DesignDocument, tokenId: string): DesignDocument {
  const tokens = (doc.tokens || []).filter((t) => t.id !== tokenId);

  const stripBindings = (
    bindings: Record<string, string> | undefined
  ): Record<string, string> | undefined => {
    if (!bindings || !Object.values(bindings).includes(tokenId)) return bindings;
    const remaining: Record<string, string> = {};
    for (const [prop, boundId] of Object.entries(bindings)) {
      if (boundId !== tokenId) remaining[prop] = boundId;
    }
    return Object.keys(remaining).length > 0 ? remaining : undefined;
  };

  const paintWithoutTokenId = (paint: Paint): Paint => {
    const own = paint.tokenId === tokenId;
    const stops = "stops" in paint ? paint.stops : undefined;
    const boundStop = stops?.some((stop) => stop.tokenId === tokenId) ?? false;
    if (!own && !boundStop) return paint;
    const next: Paint = { ...paint };
    if (own) delete next.tokenId;
    if (boundStop && stops) {
      (next as { stops?: typeof stops }).stops = stops.map((stop) => {
        if (stop.tokenId !== tokenId) return stop;
        const { tokenId: _stopTokenId, ...rest } = stop;
        return rest;
      });
    }
    return next;
  };

  const effectWithoutTokenId = (ef: Effect): Effect => {
    const own = (ef as { tokenId?: string }).tokenId === tokenId;
    const nextBindings = stripBindings(ef.tokenBindings);
    if (!own && nextBindings === ef.tokenBindings) return ef;
    const nextEf: any = { ...ef, tokenBindings: nextBindings };
    if (own) delete nextEf.tokenId;
    return nextEf as Effect;
  };

  const strokeWithoutTokenId = (stroke: Stroke): Stroke => {
    const own = stroke.tokenId === tokenId;
    const nextPaint = stroke.paint ? paintWithoutTokenId(stroke.paint) : undefined;
    const painted = nextPaint !== stroke.paint;
    if (!own && !painted) return stroke;
    const next = { ...stroke };
    if (own) delete next.tokenId;
    if (painted) next.paint = nextPaint;
    return next;
  };

  const unbindMatching = (el: DesignElement): DesignElement => {
    let changed = false;
    let next = el;

    if (next.fills?.some((p) => paintWithoutTokenId(p) !== p)) {
      next = { ...next, fills: next.fills.map(paintWithoutTokenId) };
      changed = true;
    }
    if (next.strokes?.some((st) => strokeWithoutTokenId(st) !== st)) {
      next = { ...next, strokes: next.strokes.map(strokeWithoutTokenId) };
      changed = true;
    }
    if (next.effects?.some((ef) => (ef as { tokenId?: string }).tokenId === tokenId || stripBindings(ef.tokenBindings) !== ef.tokenBindings)) {
      next = { ...next, effects: next.effects.map(effectWithoutTokenId) };
      changed = true;
    }

    const layerBindings = stripBindings(next.tokenBindings);
    if (layerBindings !== next.tokenBindings) {
      next = { ...next, tokenBindings: layerBindings };
      changed = true;
    }

    if (next.type === "text" && (next as TextElement).style?.tokenBindings) {
      const text = next as TextElement;
      const nextBindings = stripBindings(text.style.tokenBindings);
      if (nextBindings !== text.style.tokenBindings) {
        next = { ...text, style: { ...text.style, tokenBindings: nextBindings } };
        changed = true;
      }
    }

    return changed ? next : el;
  };

  const styles = (doc.styles || []).map((s) => {
    if (s.styleType === "paint" && s.paints?.some((p) => paintWithoutTokenId(p) !== p)) {
      return { ...s, paints: s.paints.map(paintWithoutTokenId) };
    }
    if (s.styleType === "stroke" && s.strokes?.some((st) => strokeWithoutTokenId(st) !== st)) {
      return { ...s, strokes: s.strokes.map(strokeWithoutTokenId) };
    }
    if (s.styleType === "effect" && s.effects?.some((ef) => (ef as { tokenId?: string }).tokenId === tokenId || stripBindings(ef.tokenBindings) !== ef.tokenBindings)) {
      return { ...s, effects: s.effects.map(effectWithoutTokenId) };
    }
    if (s.styleType === "text") {
      let next: DesignStyle = s;
      if (s.style?.tokenBindings) {
        const nextBindings = stripBindings(s.style.tokenBindings);
        if (nextBindings !== s.style.tokenBindings) {
          next = { ...s, style: { ...s.style, tokenBindings: nextBindings } };
        }
      }
      return next;
    }
    return s;
  });

  const updatePages = (doc.pages || []).map((page) => {
    const updatedElements = mapElements(page.children || [], unbindMatching);
    return updatedElements !== page.children ? { ...page, children: updatedElements } : page;
  });

  return {
    ...doc,
    tokens,
    styles,
    pages: updatePages
  };
}

export function bindFillStyle(el: DesignElement, style: PaintStyle, activeTheme?: string): DesignElement {
  return {
    ...el,
    fillStyleId: style.id,
    fills: JSON.parse(JSON.stringify(resolvePaintStylePaints(style)))
  };
}

type StyleIdKey = "fillStyleId" | "strokeStyleId" | "textStyleId" | "effectStyleId";

/**
 * Drop one style binding.
 *
 * On an instance an ABSENT id does not mean "unbound" — it means "inherit the
 * master's", which is exactly what `resolveInstanceBox` reads — so deleting the
 * key hands the binding straight back and the detach button appears to do
 * nothing. The detach therefore has to be recorded as an explicit `null` there,
 * which is why that field is nullable at all.
 */
function unbindStyleId(el: DesignElement, key: StyleIdKey): DesignElement {
  const next = { ...el } as unknown as Record<string, unknown>;
  if (el.type === "instance") next[key] = null;
  else delete next[key];
  return next as unknown as DesignElement;
}

export function unbindFillStyle(el: DesignElement, style?: PaintStyle, activeTheme?: string): DesignElement {
  const next = unbindStyleId(el, "fillStyleId");
  if (style && style.paints) {
    return {
      ...next,
      fills: JSON.parse(JSON.stringify(resolvePaintStylePaints(style)))
    };
  }
  return next;
}

/**
 * Move one row inside a style-type group. The groups are filtered views of one
 * flat `styles` array, so the move happens within the group's own subsequence —
 * moving whole-array indices would drag the other types' rows along.
 */
export function reorderStyles(
  styles: readonly DesignStyle[],
  styleType: StyleType,
  fromRow: number,
  insertBeforeRow: number
): DesignStyle[] {
  const group = styles.filter((s) => s.styleType === styleType);
  if (fromRow < 0 || fromRow >= group.length) return styles.slice();
  const [moved] = group.splice(fromRow, 1);
  const target = insertBeforeRow > fromRow ? insertBeforeRow - 1 : insertBeforeRow;
  group.splice(Math.max(0, Math.min(group.length, target)), 0, moved);
  let cursor = 0;
  return styles.map((s) => (s.styleType === styleType ? group[cursor++] : s));
}

export function bindTextStyle(el: TextElement, style: TextStyleDefinition): TextElement {
  return {
    ...el,
    textStyleId: style.id,
    style: {
      ...(el.style || {}),
      ...style.style
    },
    ...(style.style.tokenBindings
      ? {
          tokenBindings: {
            ...(el.tokenBindings || {}),
            ...style.style.tokenBindings
          }
        }
      : {})
  };
}

export function unbindTextStyle(el: TextElement, style?: TextStyleDefinition): TextElement {
  const next = { ...el };
  delete next.textStyleId;
  if (style) {
    return {
      ...next,
      style: {
        ...(next.style || {}),
        ...style.style
      }
    };
  }
  return next;
}

export function bindEffectStyle(el: DesignElement, style: EffectStyle): DesignElement {
  return {
    ...el,
    effectStyleId: style.id,
    effects: JSON.parse(JSON.stringify(style.effects))
  };
}

export function unbindEffectStyle(el: DesignElement, style?: EffectStyle): DesignElement {
  const next = unbindStyleId(el, "effectStyleId");
  if (style?.effects) {
    return {
      ...next,
      effects: JSON.parse(JSON.stringify(style.effects))
    };
  }
  return next;
}

export function bindCompositeStrokeStyle(el: DesignElement, style: StrokeStyle): DesignElement {
  return {
    ...el,
    strokeStyleId: style.id,
    strokes: JSON.parse(JSON.stringify(style.strokes))
  };
}

export function unbindCompositeStrokeStyle(el: DesignElement, style?: StrokeStyle): DesignElement {
  const next = unbindStyleId(el, "strokeStyleId");
  if (style?.strokes) {
    return {
      ...next,
      strokes: JSON.parse(JSON.stringify(style.strokes))
    };
  }
  return next;
}

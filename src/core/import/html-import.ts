/**
 * HTML → Design DSL.
 *
 * The importer converts a page's RENDERED result, not its CSS: flex, grid,
 * wrapping and font metrics are decided by a layout engine, so the page is
 * mounted in an isolated shadow root, measured at one viewport width, and the
 * measurements are what the DSL is written from. Every container is given both
 * a `layout` and the boxes its children actually occupied, and `verifyImport`
 * then asks the engine's own layout pass to reproduce them — anything it cannot
 * is downgraded to the measured coordinates rather than left wrong.
 *
 * This is a one-shot conversion, not a runtime: the result is ordinary editable
 * elements, and nothing here ships into the saved document.
 */

import type { DesignElement } from "../dsl/types";
import { mountHtmlDocument } from "./html-dom";
import { bindStylesByValue } from "./style-binding";
import { createHtmlTokens } from "./html-tokens";
import { importedDesignSystem } from "./imported-tokens";
import { domPath, walkDocument, type WalkState } from "./html-walk";
import { verifyImport } from "./html-verify";
import { DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH, type ImportOptions, type ImportReport, type ImportResult } from "./html-types";

export type { ImportOptions, ImportReport, ImportResult } from "./html-types";
export { DEFAULT_VIEWPORT_WIDTH, DEFAULT_VIEWPORT_HEIGHT } from "./html-types";

export async function importHtmlDocument(html: string, options: ImportOptions = {}): Promise<ImportResult> {
  if (!html.trim()) throw new Error("The document is empty");
  if (options.signal?.aborted) throw new DOMException("Import aborted", "AbortError");

  options.onProgress?.("mount", 20);
  const mounted = await mountHtmlDocument(
    html,
    options.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH,
    options.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT,
    options.signal
  );
  try {
    if (options.signal?.aborted) throw new DOMException("Import aborted", "AbortError");
    options.onProgress?.("assets", 45);

    // The probe costs a DOM append and a layout read, and a page has a handful of
    // distinct fonts, so the answer is memoised on the font itself.
    const lineHeights = new Map<string, number | undefined>();
    const normalLineHeight = (cs: CSSStyleDeclaration): number | undefined => {
      const key = [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.fontStyle, cs.fontVariantNumeric].join("|");
      if (!lineHeights.has(key)) {
        lineHeights.set(
          key,
          mounted.measureNormalLineHeight({
            fontFamily: cs.fontFamily,
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            fontStyle: cs.fontStyle,
            fontVariantNumeric: cs.fontVariantNumeric
          })
        );
      }
      return lineHeights.get(key);
    };

    const state: WalkState = {
      body: mounted.body,
      origin: mounted.origin,
      unmapped: [],
      sources: [],
      measured: new Map(),
      missing: [],
      backgroundMisses: [],
      takenIds: new Set(options.takenIds ?? []),
      normalLineHeight,
      authored: mounted.authored,
      assets: mounted.assets,
      // Read before the walk so `var(--x)` can be answered from the declared
      // table while the element's own cascade is still available per node.
      tokens: createHtmlTokens(mounted.customProperties(), { tokens: options.tokens }),
      signal: options.signal
    };

    // A pseudo whose box was rebuilt but whose text could not be (`counter()`,
    // `attr()`, `url()`) is a gap the walk never sees, so it is recorded here.
    for (const gap of mounted.pseudos.unreproducible) {
      state.unmapped.push({
        path: domPath(gap.element, mounted.body),
        property: `::${gap.pseudo}`,
        value: gap.content.slice(0, 120)
      });
    }
    // And one that has no box to rebuild: `::first-line` and `::placeholder`
    // restyle a run the host already drew, so their typography is lost outright.
    for (const decoration of mounted.pseudos.decorations) {
      state.unmapped.push({
        path: domPath(decoration.element, mounted.body),
        property: `::${decoration.pseudo}`,
        value: decoration.properties.join(", ")
      });
    }

    // A page's own typefaces are not inlined, and a text drawn in a fallback face
    // is a difference no measurement in this file will show — so it is named.
    for (const url of mounted.assets.fontSources) {
      state.unmapped.push({ path: "body", property: "@font-face", value: url.slice(0, 120) });
    }

    if (options.signal?.aborted) throw new DOMException("Import aborted", "AbortError");
    options.onProgress?.("measure", 70);
    const root = walkDocument(state, options.rootName ?? "Imported Page", mounted.documentElement);
    if (!root) throw new Error("Nothing in the document produced an element");

    // Backgrounds were recorded by DOM path, because their element had no id yet.
    // `sources` is the map the walk kept, so the two join here — and a path with
    // no element (an empty box that produced nothing) is simply dropped.
    const idByPath = new Map(state.sources.map((source) => [source.path, source.id]));
    for (const miss of state.backgroundMisses) {
      const elementId = idByPath.get(miss.path);
      if (elementId) state.missing.push({ elementId, url: miss.url, paint: miss.paint });
    }

    if (options.signal?.aborted) throw new DOMException("Import aborted", "AbortError");
    options.onProgress?.("build", 90);
    const verified = verifyImport([root], state.measured);
    // Tokens first, styles second: a layer the page wrote as `var(--x)` already
    // points at the token it named, and a by-value match onto a look-alike style
    // would put a second, unrelated binding on the same layer.
    const bound = bindStylesByValue(verified.elements, options.styles ?? []);
    options.onProgress?.("build", 100);
    return {
      elements: bound.elements,
      assets: mounted.assets.assets,
      missing: state.missing,
      ...(state.tokens && state.tokens.tokens.length > 0
        ? {
            tokens: importedDesignSystem(
              state.tokens.tokens,
              state.tokens.modes,
              [],
              state.tokens.numberModes
            )
          }
        : {}),
      report: {
        elementCount: countElements(bound.elements),
        downgraded: verified.downgraded,
        unmapped: state.unmapped,
        sources: state.sources,
        maxDelta: round2(verified.maxDelta),
        maxTextDelta: round2(verified.maxTextDelta),
        styleBindings: bound.bound,
        tokensCreated: state.tokens?.tokens.length ?? 0,
        tokenBindings: state.tokens?.bound ?? 0
      }
    };
  } finally {
    mounted.dispose();
  }
}

function countElements(elements: DesignElement[]): number {
  let total = 0;
  for (const el of elements) {
    total += 1;
    if (el.type === "frame" || el.type === "component" || el.type === "componentSet") {
      total += countElements(el.children ?? []);
    }
  }
  return total;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

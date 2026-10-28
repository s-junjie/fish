import type { DesignDocument, DesignStyle, FontSpec, AssetRef, Page, CanvasSpec, DesignElement, PaintStack, Stroke } from "../types";
import versions from "../versions.json";
import { normalizePageViewport } from "../../geometry/viewport";
import { asNumber, isPlainObject, NormalizeContext, NormalizeResult, NormalizationRepair, type RawComponentBoxes } from "./shared";
import { normalizePaint, normalizePaintStackEntries } from "./paint";
import { normalizeEffects } from "./effects";
import { textStyleRefusal, toTextStyleDeclaration } from "../text-style-declarations";
import { normalizeTextStyle } from "./text-sizing";
import { normalizeStrokes } from "./stroke";
import { normalizeElement } from "./element";
import { collectVariables, resolveValueTokens } from "./resolve-values";
import { normalizeTokens } from "./tokens";

export function normalizeFontSpecs(raw: unknown): FontSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: FontSpec[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const family = typeof item.family === "string" ? item.family.trim() : "";
    if (!family) continue;
    out.push({
      family,
      ...(typeof item.src === "string" && item.src ? { src: item.src } : {}),
      ...(typeof item.weight === "number" || item.weight === "normal" || item.weight === "bold"
        ? { weight: item.weight }
        : {}),
      ...(item.style === "normal" || item.style === "italic" ? { style: item.style } : {})
    });
  }
  return out;
}

/** Project each record onto the fields the engine keeps. */
export function normalizeAssetRefs(raw: unknown): AssetRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AssetRef[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const uri = typeof item.uri === "string" ? item.uri : typeof item.src === "string" ? item.src : typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : "";
    const credit = isPlainObject(item.credit) ? (item.credit as AssetRef["credit"]) : undefined;
    out.push({
      id: (typeof item.id === "string" && item.id) || `asset_${out.length + 1}`,
      name: (typeof item.name === "string" && item.name) || "Untitled asset",
      uri,
      ...(asNumber(item.width) !== undefined ? { width: asNumber(item.width) } : {}),
      ...(asNumber(item.height) !== undefined ? { height: asNumber(item.height) } : {}),
      ...(asNumber(item.duration) !== undefined ? { duration: asNumber(item.duration) } : {}),
      ...(credit ? { credit } : {})
    });
  }
  return out;
}

/**
 * The document's mode list: `[{ id, name }]`, deduped by id.
 *
 * An entry without an id cannot be selected by `activeTheme` or by a container's
 * `themeMode`, and two entries sharing an id make "which Dark" unanswerable — so
 * the first one wins and the rest are dropped here rather than at read time.
 */
export function normalizeDocumentModes(raw: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
    out.push({ id, name });
  }
  return out;
}

/**
 * Whether the author actually wrote a colour on this style.
 *
 * `normalizeTextStyle` always answers with one (a LAYER's style needs a colour),
 * so the value alone cannot tell an authored colour from the default — and
 * reporting a default as "dropped" would put a repair on every text style ever
 * written. The spellings checked here are the ones `normalizeTextStyle` reads.
 */
function authoredInk(item: Record<string, unknown>): boolean {
  const style = isPlainObject(item.style) ? (item.style as Record<string, unknown>) : {};
  return ["color", "fill", "textColor"].some(
    (key) => typeof style[key] === "string" && Boolean((style[key] as string).trim())
  ) || ["color", "textColor"].some(
    (key) => typeof item[key] === "string" && Boolean((item[key] as string).trim())
  );
}

export function normalizeStyles(raw: unknown, repairs?: NormalizationRepair[]): DesignStyle[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignStyle[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `style_${Date.now()}_${out.length}`;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Untitled Style";
    const description = typeof item.description === "string" && item.description.trim() ? item.description.trim() : undefined;
    const styleType = item.styleType ?? item.type;
    if (styleType === "paint") {
      // A paint style stores its stack under `paints` (not `fills`, which is the
      // element property). Reading the wrong key silently dropped every colour
      // and fell back to a default black solid on every load / restore / edit.
      const rawPaints = (item as Record<string, unknown>).paints ?? (item as Record<string, unknown>).fills;
      const paints = normalizePaintStackEntries(rawPaints, "/styles", []);
      out.push({
        id,
        name,
        ...(description ? { description } : {}),
        styleType: "paint",
        paints: paints && paints.length > 0 ? paints : [{ type: "solid", color: "#000000" }]
      });
    } else if (styleType === "text") {
      // A text style is TYPE: `style` is the whole of it, and everything else it
      // can own is `TEXT_STYLE_KEYS`. Its shadow is NOT folded into `effects` —
      // a style that carried one repainted it over the layer on every sync,
      // which made the layer's own Effects panel a control that undid itself.
      const path = `/styles[${out.length}]`;
      const normalizedStyle = normalizeTextStyle(item.style, item, path, repairs);
      const { declaration, dropped } = toTextStyleDeclaration(normalizedStyle);
      const normalized = normalizedStyle as unknown as Record<string, unknown>;
      for (const key of dropped) {
        // `color` is the one key the normalizer always supplies (a layer needs
        // ink), so its presence proves nothing; every other droppable key is
        // emitted only when the author wrote it — under any of its spellings,
        // which is why the check is on the NORMALIZED value and not the raw key.
        const written = key === "color" ? authoredInk(item) : normalized[key] !== undefined;
        if (!written) continue;
        const value = normalized[key];
        const shown = typeof value === "string" ? value : JSON.stringify(value);
        repairs?.push({
          kind: "text",
          path: `${path}/style/${key}`,
          message: `a text style declares type only: "${key}" (${shown}) dropped — ${textStyleRefusal(key)}`
        });
      }
      if (Array.isArray(item.effects) && item.effects.length > 0) {
        repairs?.push({
          kind: "effect",
          path: `${path}/effects`,
          severity: "info",
          message: `a text style declares type only: "effects" (${item.effects.length}) dropped — ${textStyleRefusal("textShadow")}`
        });
      }
      out.push({
        id,
        name,
        ...(description ? { description } : {}),
        styleType: "text",
        style: declaration
      });
    } else if (styleType === "effect") {
      const effects = normalizeEffects(item.effects, `/styles[${out.length}]`, repairs);
      out.push({
        id,
        name,
        ...(description ? { description } : {}),
        styleType: "effect",
        effects
      });
    } else if (styleType === "stroke") {
      const strokes = normalizeStrokes(item as Record<string, unknown>, "/styles");
      const rows: Stroke[] = strokes && strokes.length > 0
        ? strokes
        : [{ color: "#000000", width: 1, align: "inside", enabled: true }];
      // Rows are the style's whole declaration: `normalizeStroke` no longer reads
      // a row-level style pointer, because a stroke style is not allowed to reach
      // into a fill style (the four kinds are independent; only tokens cross).
      out.push({
        id,
        name,
        ...(description ? { description } : {}),
        styleType: "stroke",
        strokes: rows
      });
    }
  }
  return out;
}

export const KNOWN_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "docId",
  "version",
  "id",
  "name",
  "createdAt",
  "updatedAt",
  "canvas",
  "pages",
  "activePageId",
  "styles",
  // One value per entry, beside the style table: a token is a value, a style is
  // a set of declarations, and an id lives in exactly one of the two.
  "tokens",
  "elements",
  "assets",
  "fonts",
  "metadata",
  "variables",
  // A token's other values live under a mode, and the mode list is what names
  // them. Without these four keys the whole multi-mode half of the token system
  // is dropped on load — the file keeps the stacks and can never select one.
  "modes",
  "activeTheme",
  "numberModes",
  "activeNumberMode",
  // The designated cover frame. Dropping it does not fail anything: the reader
  // falls back to the first frame, which on a deck is the board every screen sits
  // on — so the file quietly re-opens with the wrong picture as its thumbnail.
  "thumbnailNodeId"
]);

/** The keys a page is rebuilt from; anything else is dropped and reported. */
const KNOWN_PAGE_KEYS = new Set(["id", "name", "canvas", "children", "metadata"]);

/**
 * Masters can live on any page, so the instance default has to be built before
 * the page walk starts. Raw (pre-normalisation) values are deliberate: once an
 * instance has been normalised there is no way to tell an omitted axis from an
 * authored 0, which is the distinction this map exists to preserve.
 */
function collectRawComponentBoxes(source: Record<string, unknown>): RawComponentBoxes {
  const out = new Map<string, { width?: unknown; height?: unknown }>();
  const visit = (raw: unknown) => {
    if (!isPlainObject(raw)) return;
    const declaredType = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
    if (declaredType === "component" && typeof raw.id === "string" && raw.id && !out.has(raw.id)) {
      out.set(raw.id, { width: raw.width, height: raw.height });
    }
    if (Array.isArray(raw.children)) raw.children.forEach(visit);
  };
  // Pages first: when a document carries both spellings, those are the masters
  // the resolver sees. A top-level master only counts when no page supplies one.
  if (Array.isArray(source.pages)) {
    for (const page of source.pages) {
      if (isPlainObject(page) && Array.isArray(page.children)) page.children.forEach(visit);
    }
  }
  if (Array.isArray(source.elements)) source.elements.forEach(visit);
  return out;
}

export function normalizeDesignDocument(input: unknown, context?: NormalizeContext): NormalizeResult {
  const repairs: NormalizationRepair[] = [];
  const sourceInput: Record<string, unknown> = isPlainObject(input) ? input : {};

  // CSS custom properties and the non-px length forms are resolved ONCE, over
  // the raw document, before any branch reads a value. A `var()`
  // with no definition is left as written and reported, so a broken token fails
  // `fish check` rather than shipping a literal `"var(--x)"` into the engine.
  const variables = collectVariables(sourceInput.variables);
  const { value: resolvedSource, unresolved } = resolveValueTokens(sourceInput, variables);
  const source: Record<string, unknown> = resolvedSource as Record<string, unknown>;
  for (const hit of unresolved) {
    repairs.push({
      kind: "document",
      path: hit.path || "/",
      message: `"${hit.text}": no custom property (define it in "variables" or add a fallback)`
    });
  }

  if (!isPlainObject(input)) {
    repairs.push({ kind: "document", path: "/", severity: "info", message: "document is not an object; built a new one" });
  }

  const rawVersion = typeof source.version === "string" ? source.version.trim() : undefined;
  if (source.version !== undefined && !rawVersion) {
    repairs.push({
      kind: "document",
      path: "/version",
      message: `invalid version "${String(source.version)}" defaulted to "${versions.current}"`
    });
  }

  // --- canvas -------------------------------------------------------------
  const rawCanvas = isPlainObject(source.canvas) ? source.canvas : undefined;
  if (!rawCanvas) {
    repairs.push({ kind: "canvas", path: "/canvas", severity: "info", message: "canvas was missing; built from context" });
  }
  const canvas: CanvasSpec = {
    width: Math.max(1, context?.canvas?.width ?? asNumber(rawCanvas?.width) ?? 1080),
    height: Math.max(1, context?.canvas?.height ?? asNumber(rawCanvas?.height) ?? 1080),
    unit: "px",
    background:
      normalizePaint(rawCanvas?.background, "/canvas/background", repairs) ??
      normalizePaint(rawCanvas?.backgroundColor, "/canvas/backgroundColor", repairs) ?? { type: "solid", color: "#FFFFFF" }
  };

  const rawComponentBoxes = collectRawComponentBoxes(source);

  // --- elements -----------------------------------------------------------
  // The top-level array is the single-page spelling, so it gets its own id
  // ledger: sharing the pages' ledger would report every element as a duplicate
  // when a document carries both spellings.
  const rawElements = Array.isArray(source.elements) ? source.elements : [];
  const elements: DesignElement[] = [];
  rawElements.forEach((el, index) => {
    const normalized = normalizeElement(el, `/elements/${index}`, index, repairs, "el_", null, context?.preserveUnknown, new Set(), rawComponentBoxes);
    if (normalized) elements.push(normalized);
  });

  // --- pages --------------------------------------------------------------
  // One ledger across every page, because uniqueness is document-wide.
  const seenIds = new Set<string>();
  const pages: Page[] = [];
  if (Array.isArray(source.pages) && source.pages.length > 0) {
    source.pages.forEach((rawPage, pIndex) => {
      if (!isPlainObject(rawPage)) return;
      const pId = typeof rawPage.id === "string" && rawPage.id ? rawPage.id : `page_${pIndex + 1}`;
      const pName = typeof rawPage.name === "string" && rawPage.name ? rawPage.name : `Page ${pIndex + 1}`;
      const rawPageCanvas = isPlainObject(rawPage.canvas) ? rawPage.canvas : undefined;
      const pCanvas: CanvasSpec = {
        width: Math.max(1, asNumber(rawPageCanvas?.width) ?? canvas.width ?? 1080),
        height: Math.max(1, asNumber(rawPageCanvas?.height) ?? canvas.height ?? 1080),
        unit: "px",
        background:
          normalizePaint(rawPageCanvas?.background, `/pages/${pIndex}/canvas/background`, repairs) ??
          normalizePaint(rawPageCanvas?.backgroundColor, `/pages/${pIndex}/canvas/backgroundColor`, repairs) ??
          canvas.background
      };
      const rawPageEls = Array.isArray(rawPage.children) ? rawPage.children : [];
      const pElements: DesignElement[] = [];
      rawPageEls.forEach((el, index) => {
        const normalized = normalizeElement(
          el,
          `/pages/${pIndex}/children/${index}`,
          index,
          repairs,
          "el_",
          null,
          context?.preserveUnknown,
          seenIds,
          rawComponentBoxes
        );
        if (normalized) pElements.push(normalized);
      });
      const pMetadata = isPlainObject(rawPage.metadata)
        ? { ...(rawPage.metadata as Record<string, unknown>) }
        : undefined;
      if (pMetadata) {
        const viewport = normalizePageViewport(pMetadata.viewport);
        if (viewport) pMetadata.viewport = viewport;
        else delete pMetadata.viewport;
      }
      // A page is rebuilt from its five known keys, so an unknown page key is
      // dropped even under `preserveUnknown` — which is why it is reported here
      // rather than carried, the way a top-level unknown is. Without this a page
      // carrying the pre-rename `elements` list loaded as an empty page and said
      // nothing, which is indistinguishable from an empty page the author meant.
      for (const key of Object.keys(rawPage)) {
        if (KNOWN_PAGE_KEYS.has(key)) continue;
        repairs.push({
          kind: "dropped-property",
          path: `/pages/${pIndex}/${key}`,
          message: `unknown page property "${key}" is unsupported`
        });
      }
      pages.push({
        id: pId,
        name: pName,
        canvas: pCanvas,
        children: pElements,
        ...(pMetadata ? { metadata: pMetadata } : {})
      });
    });
  }

  if (pages.length === 0) {
    pages.push({
      id: "page_1",
      name: "Page 1",
      canvas: { ...canvas },
      children: elements
    });
  } else if (elements.length > 0) {
    // The top-level array is the single-page spelling. Pages that carry no
    // content of their own are a hand-edited or model-authored file whose real
    // tree sits at the top level; adopting it is the difference between
    // loading and silently losing every element. When the pages do have
    // content the array is redundant — say so rather than dropping it quietly.
    const pageHasContent = pages.some((p) => p.children.length > 0);
    if (!pageHasContent) {
      pages[0] = { ...pages[0], children: elements };
      repairs.push({
        kind: "document",
        path: "/elements",
        severity: "info",
        message: 'top-level "elements" adopted into the first page, which carried none'
      });
    } else {
      // A paged document has no top-level array, so reaching here means both
      // spellings were supplied. Only content no page accounts for is worth
      // reporting.
      const known = new Set(pages.flatMap((p) => p.children.map((e) => e.id)));
      const unaccounted = elements.filter((e) => !known.has(e.id));
      if (unaccounted.length > 0) {
        repairs.push({
          kind: "document",
          path: "/elements",
          message: `top-level "elements" carries ${unaccounted.length} element(s) the pages do not; ignored`
        });
      }
    }
  }

  let activePageId = typeof source.activePageId === "string" ? source.activePageId : pages[0].id;
  if (!pages.some((p) => p.id === activePageId)) {
    activePageId = pages[0].id;
  }

  // --- metadata -----------------------------------------------------------
  // Free-form and unread: every key is carried through untouched, including
  // ones this build has never heard of. Nothing is renamed or dropped, because
  // nothing here is interpreted — a key only becomes a rename when something
  // reads the name it was renamed to, and nothing does.
  const metadata: Record<string, unknown> | undefined = isPlainObject(source.metadata)
    ? { ...source.metadata }
    : undefined;

  // --- assemble -----------------------------------------------------------
  const now = new Date().toISOString();
  const document: Record<string, unknown> = {
    version: rawVersion || versions.current,
    ...(typeof source.$schema === "string" ? { $schema: source.$schema } : {}),
    ...(typeof source.docId === "string" ? { docId: source.docId } : {}),
    id: (typeof source.id === "string" && source.id) || (typeof source.docId === "string" && source.docId) || `doc_${Date.now()}`,
    name: (typeof source.name === "string" && source.name) || "Untitled",
    createdAt: (typeof source.createdAt === "string" && source.createdAt) || now,
    updatedAt: (typeof source.updatedAt === "string" && source.updatedAt) || now,
    canvas,
    pages,
    activePageId,
    assets: normalizeAssetRefs(source.assets)
  };

  const fonts = normalizeFontSpecs(source.fonts);
  if (fonts.length > 0) document.fonts = fonts;

  const styles = normalizeStyles(source.styles, repairs);
  if (styles.length > 0) document.styles = styles;

  const tokens = normalizeTokens(source.tokens, repairs);
  if (tokens.length > 0) document.tokens = tokens;

  // The mode list and the selected mode are what make a token's `modes` entries
  // reachable at all: dropping them leaves every token on its base value, with
  // the dark stack still in the file and no way to select it.
  const modes = normalizeDocumentModes(source.modes);
  if (modes.length > 0) document.modes = modes;
  if (typeof source.activeTheme === "string" && source.activeTheme) {
    document.activeTheme = source.activeTheme;
  }

  // The NUMBER axis, keyed by its own list. A file written before the two axes
  // were split filed a number token's per-mode values under the COLOUR mode ids;
  // adopting those ids as the number axis is what keeps an old radius from
  // silently reverting to its base value. A document with no such values keeps
  // the single default axis the Numbers tab shows, which is the whole point of
  // the split.
  const numberModes = normalizeDocumentModes(source.numberModes);
  if (numberModes.length > 0) {
    document.numberModes = numberModes;
    if (typeof source.activeNumberMode === "string" && source.activeNumberMode) {
      document.activeNumberMode = source.activeNumberMode;
    }
  } else {
    const carriesLegacyNumberModes = (tokens ?? []).some(
      (token) => token.type === "number" && token.modes && Object.keys(token.modes).length > 0
    );
    if (carriesLegacyNumberModes && modes.length > 0) {
      document.numberModes = modes;
      document.activeNumberMode =
        typeof source.activeTheme === "string" && source.activeTheme
          ? source.activeTheme
          : modes[0].id;
    }
  }

  // Kept as written, without checking that the frame still exists: a document
  // whose cover was deleted has no better answer than the reader's fallback, and
  // rewriting the id here would make a load/unload round-trip change the file.
  if (typeof source.thumbnailNodeId === "string" && source.thumbnailNodeId) {
    document.thumbnailNodeId = source.thumbnailNodeId;
  }

  if (metadata) document.metadata = metadata;

  // Kept so a later read can resolve the same `var()`s: the definitions are the
  // author's, and dropping them would turn every reference into a repair on the
  // next save. `collectVariables` accepted keys with or without the leading `--`.
  if (isPlainObject(source.variables) && Object.keys(source.variables).length > 0) {
    document.variables = source.variables;
  }

  if (context?.preserveUnknown) {
    for (const key of Object.keys(source)) {
      if (!KNOWN_TOP_LEVEL_KEYS.has(key) && document[key] === undefined) {
        document[key] = source[key];
      }
    }
  } else {
    for (const key of Object.keys(source)) {
      if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
        repairs.push({
          kind: "dropped-property",
          path: `/${key}`,
          message: `unknown top-level property "${key}" is unsupported`
        });
      }
    }
  }

  return { document: document as unknown as DesignDocument, repairs };
}

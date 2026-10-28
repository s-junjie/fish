/**
 * Mounting an HTML document inside the running app so it can be measured.
 *
 * The import is a conversion of a RENDERED page, so the page has to actually
 * render: flex, grid, wrapping and font metrics are decided by a layout engine
 * and none of them can be read off the CSS text. This module owns the one part
 * of that which touches the live document — a shadow root the app's own styles
 * cannot reach into, and the wait for fonts and images to settle before
 * anything is measured.
 */

import { collectAssets, type AssetStore } from "./html-assets";
import { materializePseudoElements, suppressPseudos, type Materialized } from "./html-pseudo";
import { customPropertiesOf, type CustomPropertyTable } from "./html-tokens";

export interface MountedHtml {
  documentElement: HTMLElement;
  body: HTMLElement;
  /** The host's viewport-absolute origin, so measured rects can be re-based to (0, 0). */
  origin: { x: number; y: number };
  /** `::before` / `::after` turned into real elements, and what could not be. */
  pseudos: Materialized;
  /** Every bitmap the page draws from, inlined or explained. */
  assets: AssetStore;
  /**
   * The used height of one line of text in a given font.
   *
   * `line-height: normal` is the default on nearly every page and computed style
   * reports it as the literal string `"normal"`, which the DSL cannot use: it
   * would fall back to its own size-tiered default (1.38× for body text) and
   * every text box would come back a few pixels taller than the page had it.
   * The browser's own answer is one line of probe text in the page's fonts.
   */
  measureNormalLineHeight(font: NormalLineHeightQuery): number | undefined;
  /**
   * What the AUTHOR wrote for a property, not what the browser resolved it to.
   *
   * Computed style is the right source for nearly everything here — it answers
   * "what box is this" — but it is the wrong source for a track list: `1fr`
   * comes back as the px it resolved to at this one width, and
   * `repeat(auto-fit, …)` comes back as however many tracks that width fit. Both
   * are the information the ratio existed to carry, and both are gone the moment
   * the frame is resized.
   */
  authored: (el: Element, property: string) => string | undefined;
  /**
   * Every custom property the page declares at document scope, read before the
   * walk and not per element: which `--x` exists is a fact about the page, while
   * which one an element inherits is the cascade's and stays with `authored`.
   */
  customProperties: () => CustomPropertyTable;
  dispose: () => void;
}

export interface NormalLineHeightQuery {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  fontVariantNumeric: string;
}

/**
 * Far enough off screen that nothing is painted where a user can see it, while
 * `position: absolute` keeps the document from adding a scrollbar. A `display:
 * none` or `visibility: hidden` host would measure every box as zero.
 */
const HOST_OFFSET = -100000;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "title",
  "base",
  "noscript",
  "template",
  // `<select>` is reported with the value it shows; its `<option>`s are not
  // boxes the page drew — they are the menu it opens — and each one imported as
  // a 0×0 text node behind it.
  "option",
  "optgroup"
]);

export function shouldSkipTag(tagName: string): boolean {
  return SKIP_TAGS.has(tagName.toLowerCase());
}

/** What a replaced element with no size of its own measures (`CSS` default object size). */
const DEFAULT_SVG_SIZE = { width: 300, height: 150 };

/** Absolute units only. A `%` is not a length to pin — it asks for a viewport this file has none of. */
const SVG_UNITS_PX: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 25.4 / 4,
  em: 16,
  rem: 16,
  ex: 8
};

function svgLength(raw: string | null): number | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = text.slice(String(value).length).trim() || "px";
  const perPx = SVG_UNITS_PX[unit];
  return perPx ? value * perPx : null;
}

/**
 * The size a standalone SVG draws at: its `width`/`height` when they are
 * lengths, else its `viewBox`, else nothing at all.
 *
 * Deliberately not "whatever the layout gives it" — see the caller.
 */
function svgIntrinsicSize(svg: SVGElement): { width: number; height: number } {
  const box = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const vbWidth = box.length === 4 && box[2] > 0 ? box[2] : null;
  const vbHeight = box.length === 4 && box[3] > 0 ? box[3] : null;
  return {
    width: Math.round(svgLength(svg.getAttribute("width")) ?? vbWidth ?? DEFAULT_SVG_SIZE.width),
    height: Math.round(svgLength(svg.getAttribute("height")) ?? vbHeight ?? DEFAULT_SVG_SIZE.height)
  };
}

export async function mountHtmlDocument(
  html: string,
  viewportWidth: number,
  viewportHeight: number,
  signal?: AbortSignal
): Promise<MountedHtml> {
  if (signal?.aborted) throw new DOMException("Import aborted", "AbortError");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  stripActiveContent(parsed);
  rewriteRootSelectors(parsed);

  const host = document.createElement("div");
  host.setAttribute("data-fish-import-host", "");
  // Geometry is inline, the ISOLATION is not.
  //
  // An inline `all: initial` would be the tidiest way to block the app's own
  // font stack from crossing the shadow boundary — but inline wins over every
  // stylesheet rule, including the page's own `:root` declarations once they are
  // rewritten onto `:host`. So the reset lives in the shadow stylesheet, ahead of
  // the page's, and the page's rules are free to override it. Only the host's own
  // box is inline, and the page has no business setting that.
  //
  // `viewportWidth`/`viewportHeight` size THIS box only. A page that measures
  // itself in `vw`/`vh` resolves those against the real window whatever this box
  // says, so a caller whose two numbers disagree with the window gets a page laid
  // out at the window size inside a frame of the caller's size — the tail of the
  // layout then falls outside the artboard. `useHtmlImport` passes both from the
  // window for exactly that reason; any other caller should too.
  host.style.cssText = [
    "display: block",
    "position: absolute",
    `left: ${HOST_OFFSET}px`,
    "top: 0",
    `width: ${Math.max(1, Math.round(viewportWidth))}px`,
    `height: ${Math.max(1, Math.round(viewportHeight))}px`,
    "pointer-events: none",
    "contain: layout style"
  ].join("; ");

  // Read before the move: `Document.body` is a getter over the document's own
  // tree, and the tree leaves it the moment the root is reparented.
  const documentElement = parsed.documentElement;
  const body = documentElement.querySelector("body") ?? documentElement;

  // An `.svg` file is a bare `<svg>` root, so the HTML parser drops it straight
  // under `<body>` — and `<svg>` is `display: inline` unless told otherwise,
  // which the walk reads as inline content. It produced nothing at all, and the
  // import failed with "Nothing in the document produced an element"; the file
  // picker did not even offer `.svg`, so this never had a chance to be noticed.
  //
  // Only when the body holds nothing but SVG. A page that merely EMBEDS an svg
  // has other children, and forcing one of those to a block would reflow the
  // very layout this mount exists to measure.
  const bodyChildren = Array.from(body.children);
  if (bodyChildren.length > 0 && bodyChildren.every((c) => c.tagName.toLowerCase() === "svg")) {
    for (const child of bodyChildren) {
      const svg = child as SVGElement;
      const box = svgIntrinsicSize(svg);
      svg.style.display = "block";
      // The size has to be pinned, not merely unlocked. As a block the root
      // takes the host's full width when it has no `width` of its own, so an
      // icon authored as nothing but `viewBox="0 0 24 24"` measured 1384 wide
      // — the viewport, not the drawing — and every shape inside it came in 57×
      // too large.
      svg.style.width = `${box.width}px`;
      svg.style.height = `${box.height}px`;
    }
    // Same reason, one level up: `body` is a block too, so the page frame
    // around a 24×24 icon was a 1384×24 box, and the import zoomed out to fit
    // a window's worth of nothing.
    body.style.width = "fit-content";
  }

  const shadow = host.attachShadow({ mode: "open" });
  const reset = document.createElement("style");
  reset.textContent = ":host { all: initial; }";
  shadow.appendChild(reset);
  // The whole `<html>` goes in, not just `body.innerHTML`. A shadow root has no
  // UA `html` / `body` boxes of its own, and page CSS written against those
  // selectors — plus the UA stylesheet's own `body { margin: 8px }` — would
  // otherwise match nothing and shift every element in the import.
  shadow.appendChild(documentElement);
  // After the page's own sheets, so its `content: none !important` is the last
  // word on tree order as well as on importance.
  suppressPseudos(shadow);

  document.body.appendChild(host);

  try {
    if (signal?.aborted) throw new DOMException("Import aborted", "AbortError");
    await waitForReady(documentElement, signal);
    if (signal?.aborted) throw new DOMException("Import aborted", "AbortError");
    const pseudos = materializePseudoElements(documentElement);
    // After the pseudos, so a copied background is one of the URLs collected.
    const assets = await collectAssets(documentElement, signal);
    if (signal?.aborted) throw new DOMException("Import aborted", "AbortError");
    const hostRect = host.getBoundingClientRect();
    return {
      documentElement,
      body,
      origin: { x: hostRect.left, y: hostRect.top },
      pseudos,
      assets,
      measureNormalLineHeight: (font) => probeLineHeight(shadow, font),
      authored: (el, property) => authoredDeclaration(shadow, el, property),
      // Read from the mounted tree rather than the source text: only the mount
      // has rewritten `:root` into `:host`, and a sheet the browser refused is
      // a sheet no token should be minted from.
      customProperties: () => customPropertiesOf(shadow),
      dispose: () => host.remove()
    };
  } catch (err) {
    host.remove();
    throw err;
  }
}

/**
 * `:root` → `:host`, in every stylesheet the page brought with it.
 *
 * `:root` matches the root element of the DOCUMENT, and a shadow root is not an
 * element — so inside the shadow tree the selector matches nothing. Every design
 * token a page declares there (`--panel`, `--sans`, `--r-panel`) then leaves
 * `var()` invalid at computed-value time, which resolves to the inherited value:
 * the whole palette, the type stack and every radius come out wrong, while the
 * geometry stays close enough that it reads as "a bit off" rather than as a
 * missing stylesheet.
 *
 * `:host` is the element that plays the same role in a shadow tree — it is the
 * shadow tree's root, and declarations on it inherit to everything inside. The
 * rewrite is safe as a plain token replace because `:root` has no other meaning
 * in CSS.
 */
function rewriteRootSelectors(doc: Document): void {
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    const css = style.textContent ?? "";
    if (!css.includes(":root")) continue;
    style.textContent = css.replace(/:root\b/g, ":host");
  }
}

/**
 * The winning declaration for one property, straight off the page's own sheets.
 *
 * The cascade is reproduced in its two real terms — specificity, then document
 * order — and in nothing else: no `!important`, no layers, no `@scope`. A track
 * list is written once per grid in practice, and a wrong-but-simple answer here
 * costs a ratio, which the measurement was always going to override.
 *
 * `@media` is tested against the WINDOW rather than the host's 1280px box,
 * because that is what the browser did when it rendered the page being measured:
 * a rule that is not in force did not put these tracks on screen.
 *
 * A sheet whose rules cannot be read — a cross-origin one — leaves `best`
 * undefined and the caller falls back to computed style. The scan of the sheets
 * AFTER it still runs: the throw is caught around one `visit` call, not around
 * the loop.
 */
function authoredDeclaration(shadow: ShadowRoot, el: Element, property: string): string | undefined {
  const inline = (el as HTMLElement).style?.getPropertyValue(property);
  if (inline) return inline;

  let best: { weight: number; order: number; value: string } | undefined;
  let order = 0;
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      order += 1;
      const style = rule as CSSStyleRule;
      if (typeof style.selectorText === "string") {
        const value = style.style.getPropertyValue(property);
        if (!value) continue;
        let hit = false;
        // A selector the page wrote for a shadow context (`:host`, the rewrite
        // of `:root`) is not valid against an element inside the tree.
        try {
          hit = el.matches(style.selectorText);
        } catch {
          hit = false;
        }
        if (!hit) continue;
        const weight = specificity(style.selectorText);
        if (!best || weight > best.weight || (weight === best.weight && order > best.order)) {
          best = { weight, order, value };
        }
        continue;
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (!nested || typeof nested.length !== "number") continue;
      const condition = (rule as CSSConditionRule).conditionText;
      if (typeof condition === "string" && !ruleMatches(rule, condition)) continue;
      visit(nested);
    }
  };

  for (const sheet of Array.from(shadow.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A sheet from another origin has no readable rules, and the element it
      // styled was never going to import correctly anyway.
    }
  }
  return best?.value;
}

const RULE_MEDIA = 4;
const RULE_SUPPORTS = 12;

/**
 * Whether the rules inside a conditional group were in force when the browser
 * rendered the page.
 *
 * The two conditions are asked of two different APIs because they are two
 * different questions. `CSS.supports()` answers "is this a condition the UA
 * understands", which is not "does this match" — handed a media query it is
 * wrong in both directions: `@media (max-width: 600px)` reads as supported on
 * any window, and `screen and (min-width: 900px)` fails to parse at all. Only
 * `matchMedia` asks about the window, which is the question a `@media` rule is
 * for. They are told apart by `CSSRule.type` rather than `instanceof`, so this
 * does not depend on the `CSSMediaRule` global being present.
 *
 * A condition that cannot be parsed is reported as NOT matching, which is what
 * the browser did with it too. Any other conditional group — an `@container`
 * above all — has no standalone evaluation here and is taken as matching: this
 * function exists to recover what the AUTHOR wrote, and a group skipped
 * wholesale loses every declaration under it, where a group wrongly admitted
 * only ever competes with a computed-style fallback that wins on geometry
 * anyway.
 */
export const ruleMatches = (rule: CSSRule, condition: string): boolean => {
  try {
    if (rule.type === RULE_MEDIA) return window.matchMedia(condition).matches;
    if (rule.type === RULE_SUPPORTS) return CSS.supports(condition);
    return true;
  } catch {
    return false;
  }
};

/**
 * IDs, then classes/attributes/pseudo-classes, then types — the cascade's own order.
 *
 * `:where()` contributes zero no matter what it wraps, and its contents are
 * therefore stripped before counting: leaving them in gave every rule an author
 * had written as `:where(.panel)` the weight of an ordinary class, so a utility
 * could lose to it and the wrong track list came back from the cascade.
 */
function specificity(selector: string): number {
  const plain = selector.replace(/:where\([^()]*\)/g, "");
  const ids = (plain.match(/#[\w-]+/g) ?? []).length;
  const classes = (plain.match(/\.[\w-]+|\[[^\]]+\]|(?<!:)::?[\w-]+(?!\()/g) ?? []).length;
  const types = (plain.match(/(?:^|[\s>+~,])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

/**
 * One line of probe text, measured in the shadow root's own fonts.
 *
 * The probe is a direct child of the shadow root rather than of `<body>`, so it
 * cannot become a flex item or a block in the page being measured. Every
 * property that matters is written INLINE, which beats the page's own type
 * selectors without needing `!important`.
 */
function probeLineHeight(shadow: ShadowRoot, font: NormalLineHeightQuery): number | undefined {
  const probe = document.createElement("div");
  probe.style.cssText = [
    "all: initial",
    "display: block",
    "position: absolute",
    "left: -10000px",
    "top: 0",
    "white-space: pre",
    "margin: 0",
    "padding: 0",
    "border: 0",
    "line-height: normal",
    `font-family: ${font.fontFamily}`,
    `font-size: ${font.fontSize}`,
    `font-weight: ${font.fontWeight}`,
    `font-style: ${font.fontStyle}`,
    `font-variant-numeric: ${font.fontVariantNumeric || "normal"}`
  ].join("; ");
  probe.textContent = "Mg";
  shadow.appendChild(probe);
  try {
    const height = probe.getBoundingClientRect().height;
    return height > 0 ? Math.round(height * 100) / 100 : undefined;
  } finally {
    probe.remove();
  }
}

/**
 * Scripts and inline handlers, removed before the document is ever attached.
 *
 * A `<script>` that arrives through `innerHTML` does not execute, but a cloned
 * one can, and an `on*` attribute fires the moment the user interacts with
 * anything on the canvas. Both are stripped from the parsed copy rather than
 * filtered at render time, so nothing downstream has to remember they exist.
 */
function stripActiveContent(doc: Document): void {
  for (const node of Array.from(doc.querySelectorAll("script"))) node.remove();
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      const isUrl =
        attr.name === "href" || attr.name === "src" || attr.name === "xlink:href" || attr.name === "action";
      if (isUrl && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * Fonts and images, in that order, because both change the boxes.
 *
 * A measurement taken before a webfont loads is a measurement of the fallback
 * face, and one taken before an `<img>` decodes is a 0×0 box — both silently
 * wrong rather than absent, which is why neither can be skipped. `fonts.ready`
 * is awaited twice around a forced layout: the first wait can resolve before a
 * face is even requested, and it is the layout read that requests it.
 */
async function waitForReady(root: HTMLElement, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const settleFonts = async () => {
    const ready = (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
    if (ready) await ready;
  };
  root.offsetHeight;
  await settleFonts();
  if (signal?.aborted) return;
  root.offsetHeight;
  await settleFonts();
  if (signal?.aborted) return;

  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map((img) => {
      if (signal?.aborted || typeof img.decode !== "function") return Promise.resolve();
      return img.decode().catch(() => undefined);
    })
  );
  // A bitmap whose bytes never arrived draws its `alt` text instead, and that
  // fallback is laid out as text: its height follows the wrapped label rather
  // than the CSS box, so a 52×64 frame held a 52×110 element (Chrome also
  // refused the percentage height). The importer reproduces no alt string, so
  // the fallback is not part of what it copies — drop it and keep the authored
  // box. Mutating `alt` leaves the element an inline non-replaced box, where
  // `width`/`height` do not apply at all (it collapses to the 16×16 broken
  // icon), so it is promoted to inline-block, which is atomic like the replaced
  // box it should have been. The unread bitmap is still reported as missing.
  for (const img of images) {
    if (img.naturalWidth !== 0) continue;
    img.alt = "";
    if (getComputedStyle(img).display === "inline") img.style.display = "inline-block";
  }
  root.offsetHeight;
}

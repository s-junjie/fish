/**
 * `::before` / `::after`, turned into real elements before anything is measured.
 *
 * A pseudo-element has no node, so it has no `getBoundingClientRect()` and no
 * place in the walk — which is how a decorative rule (a hairline highlight, an
 * annotation's divider) disappears without ever being reported. This module
 * makes one measurable: the page's own pseudo is suppressed with
 * `content: none !important`, and a clone carrying the pseudo's computed
 * declarations takes its slot in the flow.
 *
 * Copying EVERY computed declaration (except `content`) is what makes the clone
 * occupy the same box. A pseudo sized by its own declaration and one sized by
 * its context both work, because the flex and grid properties are copied too
 * and they, not `width`, are what those algorithms read.
 *
 * The suppression is verified rather than assumed: a page that declares
 * `content` with `!important` at higher specificity would keep its own pseudo
 * and render the clone in addition to it, so the clone is dropped when the real
 * pseudo is still there.
 */

export const PSEUDO_ATTRIBUTE = "data-fish-pseudo";

/**
 * The host marker is a SEPARATE attribute from the clone's.
 *
 * One attribute for both would make every element that owns a pseudo look like
 * a pseudo itself, and the walk skips pseudo elements when it numbers siblings —
 * so the shift would land on the host's real children and take every DOM path
 * after it with them.
 */
export const PSEUDO_HOST_ATTRIBUTE = "data-fish-pseudo-host";

export interface PseudoDecoration {
  element: Element;
  pseudo: string;
  /** Properties the pseudo changed from what its own host would have drawn. */
  properties: string[];
}

export interface Materialized {
  count: number;
  /**
   * Pseudos whose BOX was reproduced but whose `content` was not — `counter()`,
   * `attr()`, `url()`. Reported rather than silently emptied.
   */
  unreproducible: Array<{ element: Element; pseudo: string; content: string }>;
  /**
   * Pseudos that style a RUN of the host rather than drawing a box of their own,
   * so no clone can be made and nothing about them can be imported — named with
   * what they changed, because `::placeholder` and `::first-line` are where a
   * page's quiet typography lives.
   */
  decorations: PseudoDecoration[];
}

/**
 * Pseudos that have no element to become.
 *
 * `::before` / `::after` generate a real box and can be cloned; these three
 * restyle what their host already drew — a line inside a paragraph, or the
 * prompt text inside a control — so there is nothing to measure and no place to
 * put it. Detected rather than assumed because getting it wrong in either
 * direction costs the same either way: a pseudo nobody declared would add noise
 * to every report on the page.
 */
const DECORATIVE_PSEUDOS = ["first-line", "first-letter", "placeholder"] as const;

/** The handful of declarations a run-restyling pseudo can carry. */
const DECORATIVE_PROPERTIES = [
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "text-transform",
  "opacity"
] as const;

const XHTML = "http://www.w3.org/1999/xhtml";

function decorationsOf(el: Element): PseudoDecoration[] {
  const own = getComputedStyle(el);
  const tag = el.tagName.toLowerCase();
  const out: PseudoDecoration[] = [];
  // Only an HTML box generates these: asked of an SVG shape or a MathML element,
  // `getComputedStyle(el, "::first-line")` answers with that vocabulary's own
  // initial values, so every one of the eight properties looked different and
  // each shape in an icon reported a decoration nobody had declared.
  if (el.namespaceURI && el.namespaceURI !== XHTML) return out;
  for (const pseudo of DECORATIVE_PSEUDOS) {
    if (pseudo === "placeholder" && tag !== "input" && tag !== "textarea") continue;
    const computed = getComputedStyle(el, `::${pseudo}`);
    const properties = DECORATIVE_PROPERTIES.filter((property) => {
      const value = computed.getPropertyValue(property);
      // A pseudo this element does not generate reports every longhand as the
      // empty string, which would otherwise read as a difference on all eight.
      return value !== "" && value !== own.getPropertyValue(property);
    });
    if (properties.length > 0) out.push({ element: el, pseudo, properties: [...properties] });
  }
  return out;
}

/**
 * Replaced elements generate no pseudo-element boxes, so a rule that targets
 * them is dead CSS — cloning it would invent a box the page never drew.
 */
const REPLACED = new Set([
  "img",
  "input",
  "textarea",
  "select",
  "br",
  "hr",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed"
]);

/** Written to the clone as text, so they are not declarations to copy. */
const CONTENT = "content";

/**
 * An animation copied onto the clone would move a box that is being measured,
 * and a transition would do the same on the next style recalc.
 */
const isAnimated = (property: string): boolean =>
  property.startsWith("animation") || property.startsWith("transition") || property === "will-change";

export function suppressPseudos(shadow: ShadowRoot): void {
  const style = document.createElement("style");
  // The attribute selector is doubled to outrank a plain `.class::before` rule
  // of the page's; `!important` then beats every non-important `content`.
  //
  // The VALUE is matched rather than ignored: a host may draw both pseudos, and
  // blaming both on the first one materialised suppressed the second before it
  // could be read — so a box with a `::before` AND a `::after` lost the latter.
  style.textContent = `[${PSEUDO_HOST_ATTRIBUTE}~="before"][${PSEUDO_HOST_ATTRIBUTE}~="before"]::before, [${PSEUDO_HOST_ATTRIBUTE}~="after"][${PSEUDO_HOST_ATTRIBUTE}~="after"]::after { content: none !important; }`;
  shadow.appendChild(style);
}

export function pseudoOf(el: Element): string | null {
  const value = el.getAttribute(PSEUDO_ATTRIBUTE);
  return value === "before" || value === "after" ? value : null;
}

export function isPseudoClone(el: Element): boolean {
  return pseudoOf(el) !== null;
}

export function materializePseudoElements(root: Element): Materialized {
  const hosts = Array.from(root.querySelectorAll("*")).filter((el) => !REPLACED.has(el.tagName.toLowerCase()));
  const unreproducible: Materialized["unreproducible"] = [];
  const decorations: PseudoDecoration[] = [];
  let count = 0;

  for (const host of hosts) {
    decorations.push(...decorationsOf(host));
    // The tokens this host has already suppressed, so re-writing the attribute
    // for the second pseudo never un-suppresses the first.
    const suppressed: string[] = [];
    for (const pseudo of ["before", "after"] as const) {
      const computed = getComputedStyle(host, `::${pseudo}`);
      const content = computed.content;
      if (!content || content === "none" || content === "normal") continue;
      if (computed.display === "none") continue;

      const clone = cloneFrom(computed, content, pseudo);
      host.setAttribute(PSEUDO_HOST_ATTRIBUTE, [...suppressed, pseudo].join(" "));
      if (pseudo === "before") host.insertBefore(clone, host.firstChild);
      else host.appendChild(clone);

      if (getComputedStyle(host, `::${pseudo}`).content !== "none") {
        clone.remove();
        if (suppressed.length > 0) host.setAttribute(PSEUDO_HOST_ATTRIBUTE, suppressed.join(" "));
        else host.removeAttribute(PSEUDO_HOST_ATTRIBUTE);
        continue;
      }

      suppressed.push(pseudo);
      count++;
      if (textOf(content) === null) unreproducible.push({ element: host, pseudo, content });
    }
  }

  return { count, unreproducible, decorations };
}

function cloneFrom(computed: CSSStyleDeclaration, content: string, pseudo: string): HTMLElement {
  const clone = document.createElement("div");
  clone.setAttribute(PSEUDO_ATTRIBUTE, pseudo);
  for (let i = 0; i < computed.length; i++) {
    const property = computed[i];
    if (property === CONTENT || property.startsWith("--") || isAnimated(property)) continue;
    const value = computed.getPropertyValue(property);
    if (!value) continue;
    clone.style.setProperty(property, value, computed.getPropertyPriority(property));
  }
  const text = textOf(content);
  if (text) clone.textContent = text;
  return clone;
}

/**
 * The literal text a `content` value paints, or `null` when it is something
 * only a layout pass could resolve.
 */
function textOf(content: string): string | null {
  const value = content.trim();
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return null;
  return value.slice(1, -1).replace(/\\(["'\\])/g, "$1");
}

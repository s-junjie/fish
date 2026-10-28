/**
 * `<defs>` hygiene for the export clone.
 *
 * Two problems, both invisible in the editor and both paid for by the file the
 * user actually ships:
 *
 * - The live `<defs>` is scoped to the *viewport*, not to the export, and
 *   `retainSelection` skips it entirely (a def carries no `data-element-id`, so it
 *   reads as "not a selection victim"). A one-panel crop therefore dragged every
 *   gradient, pattern and `lg_refract_*` base64 PNG in the document along with
 *   it — measured at 44 KB of unreferenced payload for a single 300x240 glass
 *   panel.
 * - `FontSpec.src` was declared, normalized and documented for the whole life of
 *   the format and read by nothing, so the export named `Inter` and hoped the
 *   recipient had it: on a machine that did not, the font fell back and every
 *   line the exporter wrapped landed somewhere else. `injectFontFaces` below is
 *   the fix, and it is why `fonts[].src` is worth setting even though the canvas
 *   ignores it.
 */

import { DesignDocument, FontSpec } from "./dsl/types";

const SVG_NS = "http://www.w3.org/2000/svg";

/** `fill="url(#grad)"`, `clip-path="url(#c)"`, `filter="url(#f)"`, ... */
const URL_REF = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g;
/** `<textPath href="#guide">` and the SVG2 `href` spelling of the same. */
const HASH_HREF = /^\s*#([^'"\s]+)\s*$/;

/** A `<defs>` child is a definition only if nothing in it paints on its own. */
const DEF_TAGS = new Set([
  "clipPath",
  "filter",
  "linearGradient",
  "marker",
  "mask",
  "pattern",
  "radialGradient"
]);

/**
 * Drop every definition the clone does not reference, to a fixed point.
 *
 * A definition can be reached through another definition (`<linearGradient
 * href="#base">`), so one pass is not enough: removing the last referencer of
 * `base` orphans `base` in the same pass that orphaned its referencer.
 *
 * Definitions are searched for at any depth, not just as direct children: the
 * renderer wraps each element's gradients in `<g>` keyed by element id, so the
 * only definitions a `<defs>` holds directly are those wrappers. Descending is
 * what makes the pass able to see the gradients at all.
 */
export function pruneUnusedDefs(clone: SVGSVGElement): void {
  const defs = clone.querySelector("defs");
  if (!defs) return;

  // Bounded because a cycle among definitions would otherwise spin; a cycle also
  // means the first referencer is itself reachable, so nothing is orphaned.
  for (let round = 0; round < 10; round++) {
    const live = collectReferencedIds(clone);
    const doomed = Array.from(defs.querySelectorAll("*")).filter((el) => {
      if (!DEF_TAGS.has(el.tagName)) return false;
      const id = el.getAttribute("id");
      return !id || !live.has(id);
    });
    if (doomed.length === 0) break;
    doomed.forEach((el) => el.remove());
  }

  // The wrappers exist only to hold what was just dropped; leaving them behind
  // is a dozen empty groups per element in the shipped file.
  for (let round = 0; round < 10; round++) {
    const empties = Array.from(defs.querySelectorAll("g")).filter(
      (g) => !g.firstElementChild && !g.textContent
    );
    if (empties.length === 0) return;
    empties.forEach((g) => g.remove());
  }
}

/**
 * Ids the clone still points at. Definitions count as referencers of each other,
 * so a `<linearGradient href="#base">` keeps `base` alive; once the referencer
 * itself is detached the next round stops seeing the link.
 */
function collectReferencedIds(clone: SVGSVGElement): Set<string> {
  const ids = new Set<string>();
  for (const el of Array.from(clone.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      URL_REF.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_REF.exec(attr.value)) !== null) ids.add(m[1]);
      const href = HASH_HREF.exec(attr.value);
      if (href && (attr.name === "href" || attr.name.endsWith(":href"))) ids.add(href[1]);
    }
  }
  return ids;
}

/**
 * Make the declared fonts real, by writing the `@font-face` rules the document
 * already promised into the file.
 *
 * A `data:` URI is the only source that survives the `<img>` raster path — an
 * `<img>`-loaded SVG runs in a mode that blocks every external fetch — so a
 * remote `src` here serves the downloaded `.svg` and is inert for the PNG. The
 * PNG needs nothing: it rasterizes with whatever the machine already had, which
 * is the same face the canvas painted with.
 */
export function injectFontFaces(clone: SVGSVGElement, doc: DesignDocument): void {
  const fonts = (doc.fonts ?? []).filter((f) => f && f.src && f.family);
  if (fonts.length === 0) return;
  if (clone.querySelector("style[data-export-fonts]")) return;

  const style = clone.ownerDocument.createElementNS(SVG_NS, "style");
  style.setAttribute("data-export-fonts", "true");
  style.setAttribute("type", "text/css");
  style.textContent = fonts.map(fontFaceRule).join("\n");

  const defs = clone.querySelector("defs");
  if (defs) defs.appendChild(style);
  else clone.insertBefore(style, clone.firstChild);
}

function fontFaceRule(font: FontSpec): string {
  const parts = [
    `font-family: ${JSON.stringify(font.family)}`,
    `src: url(${JSON.stringify(font.src)})`
  ];
  if (font.weight !== undefined) parts.push(`font-weight: ${font.weight}`);
  if (font.style !== undefined) parts.push(`font-style: ${font.style}`);
  return `@font-face { ${parts.join("; ")}; }`;
}

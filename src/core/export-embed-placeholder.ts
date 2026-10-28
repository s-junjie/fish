import { HtmlEmbedElement } from "./dsl/types";
import { getShapeLocalPath } from "./geometry/gradient-utils";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * What an html embed becomes in a static export.
 *
 * A framed page cannot be rasterized. The export serializes the clone into an
 * `<img>`, and a browser refuses to lay out `foreignObject` in that context at
 * all — the same rule that forces text to be re-emitted as SVG `<text>` — so a
 * nested document is never going to appear in a PNG or a standalone SVG.
 *
 * The alternative is the silent one this pass already did: delete the node, and
 * a page the author deliberately placed exports as a hole in the layout that
 * nothing explains. So the box is KEPT and MARKED. The mark is a glyph, not a
 * label, because an exported file travels and the engine's strings do not — and
 * a document that ships with "Embedded page" burned into it in English would be
 * the wrong artifact for everyone else.
 */
export function emitEmbedPlaceholder(el: HtmlEmbedElement): SVGGElement {
  const group = document.createElementNS(SVG_NS, "g");

  const box = document.createElementNS(SVG_NS, "path");
  // The element's own outline, so a rounded embed keeps its corners and the
  // placeholder lands on exactly the pixels the live frame occupied.
  box.setAttribute("d", getShapeLocalPath(el));
  box.setAttribute("fill", PLACEHOLDER_FILL);
  box.setAttribute("stroke", PLACEHOLDER_STROKE);
  box.setAttribute("stroke-width", "1");
  group.appendChild(box);

  // A window mark: a frame with a title bar and two controls. Skipped on a box
  // too small to hold it legibly, which leaves the plain plate.
  const glyphW = Math.min(56, Math.max(16, Math.min(el.width, el.height) * 0.35));
  const glyphH = glyphW * 0.72;
  if (el.width < glyphW * 1.6 || el.height < glyphH * 1.6) return group;

  const x = (el.width - glyphW) / 2;
  const y = (el.height - glyphH) / 2;
  const bar = glyphH * 0.26;

  const mark = document.createElementNS(SVG_NS, "g");
  mark.setAttribute("fill", "none");
  mark.setAttribute("stroke", PLACEHOLDER_INK);
  mark.setAttribute("stroke-width", "1.5");

  const frame = document.createElementNS(SVG_NS, "rect");
  frame.setAttribute("x", String(x));
  frame.setAttribute("y", String(y));
  frame.setAttribute("width", String(glyphW));
  frame.setAttribute("height", String(glyphH));
  frame.setAttribute("rx", String(Math.min(4, glyphH / 4)));
  mark.appendChild(frame);

  const rule = document.createElementNS(SVG_NS, "line");
  rule.setAttribute("x1", String(x));
  rule.setAttribute("y1", String(y + bar));
  rule.setAttribute("x2", String(x + glyphW));
  rule.setAttribute("y2", String(y + bar));
  mark.appendChild(rule);

  for (const offset of [glyphW * 0.12, glyphW * 0.24]) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(x + offset));
    dot.setAttribute("cy", String(y + bar / 2));
    dot.setAttribute("r", "1.25");
    mark.appendChild(dot);
  }

  group.appendChild(mark);
  return group;
}

/**
 * Export-artifact neutrals, deliberately not `DESIGN.md` tokens.
 *
 * The tokens describe the workbench, and this is the one drawing that leaves it:
 * a placeholder has to read as "nothing is here" in a file the author is about
 * to ship, on whatever background they chose. A canvas-chrome colour would put
 * the tool's own palette into their artwork.
 */
const PLACEHOLDER_FILL = "#F4F4F5";
const PLACEHOLDER_STROKE = "#D4D4D8";
const PLACEHOLDER_INK = "#A1A1AA";

/**
 * Reads the rendered page and turns it into the samples `auditTextInk` grades.
 *
 * Everything here is DOM reading; every judgement lives in `core/audit/text-ink`.
 * The split is what makes the rules testable without a browser, and it keeps the
 * one part that cannot be tested in Node (a rect is whatever Chromium says it is)
 * down to measurement and lookup.
 *
 * Rects come from `getBoundingClientRect`, so the ink and its box are already in
 * one space — the page may be zoomed or panned, and only offsets between the two
 * are ever compared. The one thing that is NOT zoom-invariant is the tolerance,
 * so the canvas's own scale is measured and the rules are given it.
 */

import type { DesignDocument, DesignElement } from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/types";
import {
  authoredAlignmentOf,
  isGroupAnchor,
  unionInkRects,
  type AuditTolerance,
  type Rect,
  type TextInkSample
} from "../../core/audit/text-ink";

export interface InkCollection {
  samples: TextInkSample[];
  /** Elements the audit could not grade, and why — never dropped in silence. */
  skipped: Array<{ elementId: string; reason: string }>;
  /** Screen pixels per canvas pixel, so a tolerance written in canvas px still means that. */
  zoom: number;
}

const rectOf = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height });
const area = (r: Rect) => r.width * r.height;

/**
 * The glyph fragments inside `container`, as rects.
 *
 * Walked text node by text node rather than `selectNodeContents` on the
 * container. The text is rendered as a chain of block-level divs, each at full
 * box width, so a range over them reports the BOX — and every alignment would
 * "pass" by definition. A range over a text node returns the inline box of that
 * run, which is the only thing that moves when an alignment changes.
 *
 * The box is then assembled in `core/audit/text-ink`, which is where the
 * per-line tracking correction lives — that is geometry, and it is testable
 * without a browser.
 */
function inkRects(container: Element): Rect[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const out: Rect[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) out.push(rectOf(r));
  }
  return out;
}

/** The tracking the browser reserves past the last glyph of a line, in px. */
function trackingOf(container: Element): number {
  const spacing = parseFloat(getComputedStyle(container).letterSpacing);
  return Number.isFinite(spacing) ? spacing : 0;
}

/** The `<g>` that owns an element's paint, found by the id the renderer already writes. */
function nodeOf(id: string): SVGGElement | null {
  return document.querySelector(`[data-element-id="${CSS.escape(id)}"]`) as SVGGElement | null;
}

/**
 * The nearest painted sibling that is actually a PAIR with this one — the icon a
 * label is supposed to line up with.
 *
 * Only a sibling of the same parent counts: an icon one row up is not the thing
 * this label is glued to, and comparing against it would report a defect where
 * nothing is wrong. Sharing a parent is not enough on its own either — a
 * full-bleed texture is a sibling too — so `isGroupAnchor` states what "beside"
 * means, and a sibling that fails it leaves the group anchor unset rather than
 * becoming the thing every text is graded against.
 */
function nearestSibling(node: SVGGElement): { elementId: string; box: Rect } | null {
  const parent = node.parentElement?.closest("[data-element-id]");
  if (!parent) return null;
  const own = rectOf(node.getBoundingClientRect());
  const ownY = own.y + own.height / 2;
  const parentBox = rectOf(parent.getBoundingClientRect());
  // Descendants, not direct children: an element's paint sits under wrapper `<g>`s
  // for clip, mask and effects, so the DOM tree is deeper than the element tree.
  // The parent walk starts one level up — `closest` includes the node it starts
  // from, so asking `sib.closest(...)` would answer with `sib` itself and reject
  // every candidate.
  const candidates = Array.from(parent.querySelectorAll("[data-element-id]"))
    .filter((sib) => sib !== node && sib.parentElement?.closest("[data-element-id]") === parent)
    .map((sib) => ({
      elementId: sib.getAttribute("data-element-id") ?? "",
      box: rectOf(sib.getBoundingClientRect())
    }))
    .filter((sib) => sib.elementId !== "" && area(sib.box) > 0.5)
    .filter((sib) => isGroupAnchor(own, sib.box, parentBox));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, sib) =>
    Math.abs(sib.box.y + sib.box.height / 2 - ownY) < Math.abs(best.box.y + best.box.height / 2 - ownY) ? sib : best
  );
}

/** Screen px per canvas px, taken as the median of measured-vs-declared widths. */
function measureZoom(pairs: Array<{ measured: number; declared: number }>): number {
  const ratios = pairs
    .filter((p) => p.declared > 0.5 && p.measured > 0.5)
    .map((p) => p.measured / p.declared)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return 1;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid];
  return Number.isFinite(median) && median > 0 ? median : 1;
}

export function collectTextInk(doc: DesignDocument, rawDoc: unknown): InkCollection {
  const samples: TextInkSample[] = [];
  const skipped: InkCollection["skipped"] = [];
  const sizes: Array<{ measured: number; declared: number }> = [];

  const rawById = new Map<string, unknown>();
  for (const el of rawElements(rawDoc)) {
    const id = el.id;
    if (typeof id === "string") rawById.set(id, el);
  }

  const walk = (elements: DesignElement[], parent: DesignElement | null) => {
    for (const el of elements) {
      if (el.type === "text") {
        const node = nodeOf(el.id);
        const foreign = node?.querySelector("foreignObject") ?? null;
        const container = (foreign?.firstElementChild ?? null) as HTMLElement | null;
        if (!node) {
          skipped.push({ elementId: el.id, reason: "not on the canvas (hidden, or under a hidden ancestor)" });
        } else if ((el as { onPath?: unknown }).onPath) {
          // A `textPath` has no line box: `Range` over SVG `<text>` yields no
          // inline rects, and glyphs laid along a curve are not an alignment
          // answer. Grading one needs `getExtentOfChar` per character.
          skipped.push({ elementId: el.id, reason: "text on a path — no line box to grade" });
        } else if (!foreign || !container) {
          skipped.push({ elementId: el.id, reason: "no HTML line box under this text node" });
        } else {
          const box = rectOf(foreign.getBoundingClientRect());
          const parentNode = node.parentElement?.closest("[data-element-id]");
          sizes.push({ measured: box.width, declared: el.width ?? 0 });
          samples.push({
            elementId: el.id,
            content: (el as { content?: string }).content ?? "",
            authored: authoredAlignmentOf(rawById.get(el.id)),
            computedAlign: getComputedStyle(container).textAlign,
            box,
            ink: unionInkRects(inkRects(container), trackingOf(container)),
            group: nearestSibling(node),
            parent:
              parent && parentNode
                ? {
                    box: rectOf(parentNode.getBoundingClientRect()),
                    alignItems: alignItemsOf(parent)
                  }
                : null
          });
        }
      }
      const kids = (el as { children?: DesignElement[] }).children;
      if (kids?.length) walk(kids, el);
    }
  };

  walk(getActivePage(doc).children, null);
  return { samples, skipped, zoom: measureZoom(sizes) };
}

/** The container's cross-axis alignment, under either the flat or the nested spelling. */
function alignItemsOf(el: DesignElement): string {
  const flat = (el as unknown as Record<string, unknown>)["align-items"];
  if (typeof flat === "string") return flat;
  const nested = (el as unknown as { layout?: { align?: string } }).layout;
  return typeof nested?.align === "string" ? nested.align : "";
}

/** Raw top-level elements of whichever page the block declares active. */
function* rawElements(rawDoc: unknown): Generator<Record<string, unknown>> {
  const doc = rawDoc as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return;
  const pages = Array.isArray(doc.pages) ? (doc.pages as Array<Record<string, unknown>>) : null;
  const roots: unknown[] = pages
    ? pages.flatMap((p) => (Array.isArray(p?.children) ? (p.children as unknown[]) : []))
    : Array.isArray(doc.elements)
      ? (doc.elements as unknown[])
      : [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || typeof next !== "object") continue;
    const el = next as Record<string, unknown>;
    yield el;
    const children = Array.isArray(el.children) ? (el.children as unknown[]) : [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

export function scaledTolerance(collection: InkCollection, base: AuditTolerance): AuditTolerance {
  const z = Number.isFinite(collection.zoom) && collection.zoom > 0 ? collection.zoom : 1;
  return { x: base.x * z, y: base.y * z };
}

/**
 * Figma file → FISH pages.
 *
 * A Figma file is several `CANVAS` children of one `DOCUMENT`, and each becomes a
 * FISH page, because that is what each of them is: a named board the designer
 * flips between. The one thing this file is responsible for that no other does
 * is moving the content off Figma's origin — a real file's content routinely sits
 * at negative coordinates, and a page whose elements are off-canvas looks exactly
 * like an import that did nothing.
 */

import type { ComponentElement, DesignElement, Page } from "../dsl/types";
import { DEFAULT_CANVAS_BACKGROUND } from "../dsl/defaults";
import { mapFigmaNode, type NodeWalkState } from "./figma-node";
import { sanitizeElementId } from "../id";
import { figmaColor } from "./figma-paint";
import { FIGMA_PAGE_MARGIN, type FigmaFileResponse, type FigmaNode } from "./figma-types";
import { layoutOf, withLayout } from "../dsl/layout-flat";

const CANVAS_MIN_WIDTH = 1440;
const CANVAS_MIN_HEIGHT = 1024;

/**
 * A full file response nests pages under `document`; a `/v1/files/:key?nodes=`
 * response hands back the node directly. Both are accepted, because a caller
 * holding a subtree (a single board, shared as a link) should not have to wrap
 * it in a fake document first.
 */
export function extractFigmaRoot(json: FigmaFileResponse | FigmaNode): FigmaNode {
  const file = json as FigmaFileResponse;
  if (file.document) return file.document;
  const nodes = (file as { nodes?: Record<string, { document: FigmaNode }> }).nodes;
  if (nodes && Object.keys(nodes).length > 0) return Object.values(nodes)[0].document;
  return json as FigmaNode;
}

interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Content bounds in ABSOLUTE canvas coordinates.
 *
 * Parent origins accumulate as the walk descends, because a child's `x` / `y` are
 * local to its parent while the page's canvas size is a question about the whole
 * subtree's position on the canvas. Read from what Figma reported rather than from
 * what survived the walk, so a hidden node is excluded from the size — a page
 * sized around a subtree that is not in the document is dead space.
 *
 * A rotated element contributes the BOUND of its rotation rather than its box:
 * that is what the viewer sees, and a 100×100 square turned 45° would otherwise
 * leave the page 41px short of its own bottom-right corner.
 */
function absoluteBounds(elements: DesignElement[], into: CanvasBounds, originX = 0, originY = 0): CanvasBounds {
  for (const el of elements) {
    if (el.visible === false) continue;
    const box = rotatedBounds(el, originX, originY);
    into.minX = Math.min(into.minX, box.x);
    into.minY = Math.min(into.minY, box.y);
    into.maxX = Math.max(into.maxX, box.x + box.width);
    into.maxY = Math.max(into.maxY, box.y + box.height);
    const children = (el as { children?: DesignElement[] }).children;
    if (children?.length) absoluteBounds(children, into, box.x, box.y);
  }
  return into;
}

/** An element's absolute box, expanded to the bound of its rotation when it turns. */
function rotatedBounds(
  el: DesignElement,
  originX: number,
  originY: number
): { x: number; y: number; width: number; height: number } {
  const x = originX + el.x;
  const y = originY + el.y;
  const rotation = el.rotation ?? 0;
  if (!rotation) return { x, y, width: el.width, height: el.height };
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = el.width * cos + el.height * sin;
  const height = el.width * sin + el.height * cos;
  const centreX = x + el.width / 2;
  const centreY = y + el.height / 2;
  return { x: centreX - width / 2, y: centreY - height / 2, width, height };
}

/**
 * Move a page's TOP-LEVEL elements by a constant offset — and nothing else.
 *
 * The DSL stores every child's `x` / `y` relative to its parent, so a child
 * follows its parent for free. Recursing here would add the offset a SECOND time
 * to every descendant: a child authored 39px inside a parent would end up 39px
 * left of it once the parent had moved, which on a real file puts half the design
 * outside the frame that contains it.
 *
 * `line` / `arrow` need no special case for the same reason: their second
 * endpoint is a DELTA (`dx` / `dy`), so a uniform move of `x` / `y` moves both
 * endpoints together and the delta stays correct.
 */
export function shiftTree(elements: DesignElement[], dx: number, dy: number): DesignElement[] {
  return elements.map((el) => ({ ...el, x: round2(el.x + dx), y: round2(el.y + dy) } as DesignElement));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function canvasFor(width: number, height: number, background: string): Page["canvas"] {
  return {
    // Rounded up to the 8px grid the canvas itself snaps on, so an imported page
    // does not sit one pixel inside a grid line the rest of the document sits on.
    width: Math.max(CANVAS_MIN_WIDTH, Math.ceil((width + FIGMA_PAGE_MARGIN) / 8) * 8),
    height: Math.max(CANVAS_MIN_HEIGHT, Math.ceil((height + FIGMA_PAGE_MARGIN) / 8) * 8),
    background: { type: "solid", color: background },
    unit: "px"
  };
}

export interface BuiltPages {
  pages: Page[];
  activePageIndex: number;
  state: NodeWalkState;
}

/**
 * Build one FISH page per Figma canvas.
 *
 * The walk happens at ABSOLUTE coordinates (that is what Figma reports and what
 * `state.measured` must record for `verifyImport`), and the whole tree is shifted
 * once at the end to bring the content's top-left onto the page margin. Shifting
 * rather than re-basing per node is what keeps every child's position relative to
 * its parent intact, and the measured boxes are shifted by the same amount so the
 * two stay comparable.
 */
export function buildFigmaPages(
  json: FigmaFileResponse | FigmaNode,
  state: NodeWalkState,
  maxElements: number
): BuiltPages {
  const root = extractFigmaRoot(json);
  const children = root.children ?? [];

  // A full file response's canvases are all CANVAS; a subtree handed in directly
  // is its own single page, whatever its type.
  const canvases = children.length > 0 && children.every((c) => c.type === "CANVAS")
    ? children
    : [{ id: root.id, name: root.name, type: "CANVAS", children, backgroundColor: root.backgroundColor } as FigmaNode];

  const pages: Page[] = [];

  for (let i = 0; i < canvases.length; i++) {
    if (state.elementCount >= maxElements) break;
    const canvas = canvases[i];
    const elements = (canvas.children ?? [])
      .map((child) => mapFigmaNode(child, 0, 0, state))
      .filter((el): el is DesignElement => el !== null);

    const bounds = absoluteBounds(elements, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    if (!Number.isFinite(bounds.minX)) {
      // An empty canvas still becomes a page: a Figma file with one empty page
      // imported as no pages reads as a failure rather than as an empty board.
      pages.push({
        id: sanitizeElementId(canvas.id || `figma-page-${i + 1}`),
        name: canvas.name || `Page ${i + 1}`,
        canvas: canvasFor(0, 0, canvasBackground(canvas)),
        children: []
      });
      continue;
    }

    const dx = FIGMA_PAGE_MARGIN - bounds.minX;
    const dy = FIGMA_PAGE_MARGIN - bounds.minY;
    const shifted = shiftTree(elements, dx, dy);
    shiftMeasured(state.measured, dx, dy);

    pages.push({
      id: sanitizeElementId(canvas.id || `figma-page-${i + 1}`),
      name: canvas.name || `Page ${i + 1}`,
      canvas: canvasFor(bounds.maxX + dx, bounds.maxY + dy, canvasBackground(canvas)),
      children: shifted
    });
  }

  return { pages, activePageIndex: 0, state };
}

function shiftMeasured(measured: NodeWalkState["measured"], dx: number, dy: number): void {
  for (const [id, rect] of measured) {
    measured.set(id, { x: round2(rect.x + dx), y: round2(rect.y + dy), width: rect.width, height: rect.height });
  }
}

function canvasBackground(canvas: FigmaNode): string {
  const color = (canvas as { backgroundColor?: { r: number; g: number; b: number; a?: number } }).backgroundColor;
  // A transparent Figma canvas is the DSL's default backdrop, not a painted white:
  // painting it white would put an opaque rectangle behind every page and change
  // how a `blend-mode` layer on it reads against the canvas grid.
  if (!color || (color.a ?? 1) === 0) return DEFAULT_CANVAS_BACKGROUND;
  return figmaColor(color);
}

// ---------------------------------------------------------------------------
// Instance promotion
// ---------------------------------------------------------------------------

/** Content fingerprint for a subtree, ignoring ids and positions. */
function childSignature(elements: DesignElement[]): string {
  const node = (el: DesignElement): Record<string, unknown> => {
    const o: Record<string, unknown> = { t: el.type, w: round2(el.width), h: round2(el.height) };
    if (el.type === "text") o.c = (el as { content: string }).content;
    if (el.fills) o.f = el.fills.map((f) => `${f.type}:${f.type === "solid" ? f.color : ""}`).join(",");
    if (typeof el.opacity === "number") o.o = el.opacity;
    if (el.visible === false) o.v = 0;
    const children = (el as { children?: DesignElement[] }).children;
    if (children?.length) o.k = children.map(node);
    return o;
  };
  return JSON.stringify(elements.map(node));
}

/** Deep-clone a subtree. Every node is already shifted, so the clone needs no work. */
function cloneTree(elements: DesignElement[]): DesignElement[] {
  return elements.map((el) => {
    const next = { ...el };
    const children = (el as { children?: DesignElement[] }).children;
    if (children) (next as { children: DesignElement[] }).children = cloneTree(children);
    return next;
  });
}

function collectInstanceFrames(elements: DesignElement[], out: DesignElement[] = []): DesignElement[] {
  for (const el of elements) {
    const id = (el.metadata as { figmaComponentId?: string } | undefined)?.figmaComponentId;
    if (el.type === "frame" && id) out.push(el);
    const children = (el as { children?: DesignElement[] }).children;
    if (children) collectInstanceFrames(children, out);
  }
  return out;
}

/**
 * Promote Figma `INSTANCE` nodes into linked FISH instances.
 *
 * FISH instances hold only a `componentId` and clone their master's children at
 * render time, so an imported instance has nothing to point at unless a master
 * exists — and the Figma master usually lives outside the fetched subtree. One is
 * therefore synthesized per unique (componentId, content) pair and every matching
 * instance is pointed at it.
 *
 * Grouping by CONTENT rather than by component id alone is deliberate: two
 * instances that differ only by an override get their own master instead of being
 * flattened into a shared one, so both still render as the designer drew them. The
 * cost is that a component used ten times with five different overrides arrives as
 * five masters, which is reported rather than hidden.
 */
export function promoteFigmaInstances(pages: Page[]): Page[] {
  const instances: DesignElement[] = [];
  for (const page of pages) instances.push(...collectInstanceFrames(page.children));

  const masters: DesignElement[] = [];
  const masterByInstanceId = new Map<string, string>();
  const usedIds = new Set<string>();

  const groups = new Map<string, Map<string, DesignElement[]>>();
  for (const instance of instances) {
    const componentId = (instance.metadata as { figmaComponentId?: string }).figmaComponentId ?? "";
    if (!componentId) continue;
    const children = (instance as { children?: DesignElement[] }).children ?? [];
    const signature = childSignature(children);
    if (!groups.has(componentId)) groups.set(componentId, new Map());
    const bySignature = groups.get(componentId)!;
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature)!.push(instance);
  }

  let mx = FIGMA_PAGE_MARGIN;
  let my = FIGMA_PAGE_MARGIN;
  let rowHeight = 0;

  for (const [componentId, bySignature] of groups) {
    let variant = 0;
    for (const signature of [...bySignature.keys()].sort()) {
      const list = bySignature.get(signature)!;
      const sample = list[0];
      let masterId = `cmp_${componentId}${bySignature.size > 1 ? `_v${variant}` : ""}`;
      // Figma node ids can repeat across files and a document's ids must be
      // unique, so a colliding master id is suffixed rather than reused.
      while (usedIds.has(masterId)) masterId = `${masterId}_${variant}`;
      usedIds.add(masterId);
      variant += 1;

      if (mx + sample.width > 2400) {
        mx = FIGMA_PAGE_MARGIN;
        my += rowHeight + FIGMA_PAGE_MARGIN;
        rowHeight = 0;
      }

      masters.push(
        withLayout(
          {
            id: masterId,
            type: "component",
            name: sample.name || "Component",
            x: round2(mx),
            y: round2(my),
            width: sample.width,
            height: sample.height,
            fills: sample.fills,
            strokes: sample.strokes,
            effects: sample.effects,
            clipContent: (sample as { clipContent?: boolean }).clipContent ?? false,
            borderRadius: (sample as { borderRadius?: number | [number, number, number, number] }).borderRadius,
            metadata: { figmaComponentId: componentId },
            children: cloneTree((sample as { children?: DesignElement[] }).children ?? [])
          } as ComponentElement,
          layoutOf(sample)
        )
      );

      for (const instance of list) masterByInstanceId.set(instance.id, masterId);
      mx += sample.width + FIGMA_PAGE_MARGIN;
      rowHeight = Math.max(rowHeight, sample.height);
    }
  }

  if (masters.length === 0) return pages;

  const replaceIn = (elements: DesignElement[]): void => {
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const masterId = masterByInstanceId.get(el.id);
      if (masterId && el.type === "frame") {
        elements[i] = {
          id: el.id,
          type: "instance",
          name: el.name,
          x: el.x,
          y: el.y,
          width: el.width,
          height: el.height,
          rotation: el.rotation,
          // The mirrors have to travel with the instance: they are how a quarter
          // turn stays a quarter turn on a layer Figma reported at 90°, and a
          // replacement that keeps `rotation` but drops these lands the layer a
          // half turn from where Figma drew it. The master carries none — its
          // children are already in the instance's own space, so the flip belongs
          // to the instance and would otherwise be applied twice.
          flipX: el.flipX,
          flipY: el.flipY,
          opacity: el.opacity,
          visible: el.visible,
          componentId: masterId,
          overrides: [],
          borderRadius: (el as { borderRadius?: number | [number, number, number, number] }).borderRadius,
          metadata: el.metadata
        } as DesignElement;
      } else {
        const children = (el as { children?: DesignElement[] }).children;
        if (children) replaceIn(children);
      }
    }
  };

  for (const page of pages) replaceIn(page.children);

  let maxX = 0;
  let maxY = 0;
  for (const master of masters) {
    maxX = Math.max(maxX, master.x + master.width);
    maxY = Math.max(maxY, master.y + master.height);
  }

  return [
    ...pages,
    {
      id: `figma-components-${pages.length}`,
      name: "❖ Components (imported)",
      canvas: canvasFor(maxX, maxY, DEFAULT_CANVAS_BACKGROUND),
      children: masters
    }
  ];
}
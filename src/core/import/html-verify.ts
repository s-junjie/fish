import type { ContainerElement, DesignElement } from "../dsl/types";
import { relayoutDocumentTree } from "../compile";
import { isContainer } from "../geometry/tree-ops";
import type { Rect } from "./html-walk";
import { layoutOf, withLayout } from "../dsl/layout-flat";

export interface Downgrade {
  id: string;
  name: string;
  maxDelta: number;
}

export interface VerifyResult {
  elements: DesignElement[];
  downgraded: Downgrade[];
  /** Largest box difference anywhere after relayout, against what the browser measured. */
  maxDelta: number;
  /** Largest difference among text boxes, which is what a font mismatch shows up as. */
  maxTextDelta: number;
}

export const DEFAULT_TOLERANCE = 1;

interface Stats {
  max: number;
  text: number;
}

/**
 * Re-run the engine's own layout over the import and downgrade whatever it
 * cannot reproduce.
 *
 * This is the whole safety net, and it is deliberately a MEASUREMENT rather than
 * a set of heuristics about which CSS the DSL can express. The importer always
 * writes both a `layout` and the browser's measured boxes for its children; the
 * layout pass is then asked to place those children again, and any container
 * whose children land more than a pixel away from where the page had them loses
 * its `layout` and keeps the measured coordinates. So an `align-self`, a
 * `flex-grow` approximation, or a text the DSL wraps differently from Chromium
 * all resolve the same way — into a container that is exactly as the page
 * rendered it, and a line in the report saying which one and by how much.
 *
 * Pure: `relayoutDocumentTree` needs no browser, so this costs no second render.
 */
export function verifyImport(
  elements: DesignElement[],
  measured: Map<string, Rect>,
  tolerance: number = DEFAULT_TOLERANCE
): VerifyResult {
  let current = elements;
  const downgraded: Downgrade[] = [];

  // Each pass can only remove layouts, so it terminates; the cap is a guard
  // against a document deep enough that the bound would be large, not a limit
  // any real page reaches.
  for (let pass = 0; pass < 16; pass++) {
    const offenders = new Map<string, number>();
    scan(relayoutDocumentTree(current), 0, 0, measured, tolerance, offenders, { max: 0, text: 0 });
    if (offenders.size === 0) break;
    current = stripLayout(current, offenders, downgraded);
  }

  // Measured on the tree that is actually returned, not accumulated across the
  // passes: a container that was 700px out before it was downgraded is exactly
  // right afterwards, and reporting the peak would describe a document nobody
  // ever sees.
  const stats: Stats = { max: 0, text: 0 };
  scan(relayoutDocumentTree(current), 0, 0, measured, tolerance, new Map(), stats);
  return { elements: current, downgraded, maxDelta: stats.max, maxTextDelta: stats.text };
}

function boxDelta(a: { x: number; y: number; width: number; height: number }, b: Rect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height)
  );
}

function scan(
  elements: DesignElement[],
  originX: number,
  originY: number,
  measured: Map<string, Rect>,
  tolerance: number,
  offenders: Map<string, number>,
  stats: Stats
): void {
  for (const el of elements) {
    const x = originX + el.x;
    const y = originY + el.y;
    const truth = measured.get(el.id);

    // A rotated element's box is an axis-aligned bound, so it cannot be compared
    // against the box the DSL draws before applying the rotation.
    if (truth && !el.rotation) {
      const delta = boxDelta({ x, y, width: el.width, height: el.height }, truth);
      if (delta > stats.max) stats.max = delta;
      if (el.type === "text" && delta > stats.text) stats.text = delta;
    }

    if (!isContainer(el) || !el.children) continue;

    if (layoutOf(el)) {
      // The comparison is against the container's OWN measured origin, not its
      // relaid one: a container its parent misplaced would otherwise blame its
      // own layout for a displacement it did not cause.
      const anchor = truth ?? { x, y, width: el.width, height: el.height };
      let worst = 0;
      for (const child of el.children) {
        // A rotated child is skipped for the same reason the element above is:
        // `measured` holds the bound of its rotation while the element's box is
        // its own, and — inside a rotated container — its `x` / `y` are in that
        // container's space rather than the canvas's. Comparing the two blames
        // the parent's layout for a difference rotation caused, and strips an
        // auto-layout that is right.
        if (child.rotation || child.position === "absolute" || child.visible === false) continue;
        const childTruth = measured.get(child.id);
        if (!childTruth) continue;
        worst = Math.max(
          worst,
          boxDelta(
            { x: child.x, y: child.y, width: child.width, height: child.height },
            { x: childTruth.x - anchor.x, y: childTruth.y - anchor.y, width: childTruth.width, height: childTruth.height }
          )
        );
      }
      if (worst > tolerance) offenders.set(el.id, worst);
    }

    scan(el.children, x, y, measured, tolerance, offenders, stats);
  }
}

function stripLayout(
  elements: DesignElement[],
  offenders: Map<string, number>,
  downgraded: Downgrade[]
): DesignElement[] {
  return elements.map((el) => {
    if (!isContainer(el) || !el.children) return el;
    const children = stripLayout(el.children, offenders, downgraded);
    if (!layoutOf(el) || !offenders.has(el.id)) {
      return children === el.children ? el : ({ ...el, children } as DesignElement);
    }

    downgraded.push({
      id: el.id,
      name: el.name ?? el.type,
      maxDelta: Math.round((offenders.get(el.id) ?? 0) * 100) / 100
    });

    const rest = withLayout(el, undefined);
    // The `sizing` a layout parent forced on a child means nothing once the
    // parent has no layout — and a text left with `fit-content` is re-measured
    // against no box at all, which expands a wrapped paragraph back onto one
    // line. Stripping it is what makes the stored box the box that survives.
    return {
      ...(rest as ContainerElement),
      children: children.map(stripChildSizing)
    } as DesignElement;
  });
}

function stripChildSizing(el: DesignElement): DesignElement {
  if (isContainer(el) || el.sizing === undefined) return el;
  const { sizing: _dropped, ...rest } = el;
  return rest as DesignElement;
}

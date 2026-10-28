import type { AutoLayout, ContainerElement, DesignElement } from "../dsl/types";
import {
  computeParentOrigin,
  elementWorldAABB,
  findElementById,
  findParentById,
  insertElementIntoContainer,
  removeElementFromTree
} from "../geometry/tree-ops";
import { flattenLayout } from "../dsl/layout-flat";
import { pxLength } from "../dsl/normalize/shared";
import { isObj, mintId, num, str } from "./op-primitives";

/** Absolute origin of `parentId`'s own box, i.e. the frame children sit inside. */
export function absoluteOriginOf(els: DesignElement[], parentId: string): { x: number; y: number } | null {
  const parent = findElementById(els, parentId);
  if (!parent) return null;
  const base = computeParentOrigin(els, parentId);
  return { x: base.x + parent.x, y: base.y + parent.y };
}

export function placeElement(
  els: DesignElement[],
  element: DesignElement,
  position: unknown,
  parentId?: string
): DesignElement | null {
  const siblings: DesignElement[] = parentId
    ? ((findElementById(els, parentId) as ContainerElement | null)?.children ?? [])
    : els;
  const origin = parentId ? absoluteOriginOf(els, parentId) : { x: 0, y: 0 };
  if (!origin) return null;

  const raw = element as unknown as Record<string, unknown>;
  const elX = pxLength(raw.x ?? raw.left);
  const elY = pxLength(raw.y ?? raw.top);

  if (isObj(position)) {
    const rawX = pxLength(position.x) ?? elX ?? 0;
    const rawY = pxLength(position.y) ?? elY ?? 0;
    return { ...element, x: rawX - origin.x, y: rawY - origin.y } as DesignElement;
  }

  if (position === "side-by-side" && siblings.length > 0) {
    const right = Math.max(...siblings.map((s) => s.x + s.width));
    const top = Math.min(...siblings.map((s) => s.y));
    return { ...element, x: right + 24, y: top } as DesignElement;
  }

  return { ...element, x: elX ?? 0, y: elY ?? 0 } as DesignElement;
}

export function wrapInLayout(
  els: DesignElement[],
  ids: string[],
  grid: boolean,
  params: Record<string, unknown>
): { els: DesignElement[]; id: string } | null {
  const parents = ids.map((id) => findParentById(els, id)?.id ?? null);
  const parentId = parents[0];
  if (parents.some((p) => p !== parentId)) return null;

  const boxes = ids.map((id) => {
    const el = findElementById(els, id);
    if (!el) return null;
    const origin = computeParentOrigin(els, id);
    return elementWorldAABB(el, origin.x, origin.y);
  });
  if (boxes.some((b) => b === null)) return null;
  const rects = boxes as { x: number; y: number; width: number; height: number }[];
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));

  const parentAbs = parentId ? absoluteOriginOf(els, parentId) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
  const frameId = str(params.id) ?? mintId("wrap");
  const children = ids
    .map((id) => findElementById(els, id))
    .filter((el): el is DesignElement => el !== null)
    .map((el) => ({ ...el, x: el.x - (minX - parentAbs.x), y: el.y - (minY - parentAbs.y) }) as DesignElement);

  const layout: AutoLayout = grid
    ? {
        mode: "grid",
        columns: num(params.columns) ?? 2,
        columnGap: num(params.gap) ?? 24,
        rowGap: num(params.gap) ?? 24,
        padding: num(params.padding) ?? 0
      }
    : {
        mode: "flex",
        direction: params.direction === "row" ? "row" : "column",
        gap: num(params.gap) ?? 24,
        padding: num(params.padding) ?? 0
      };

  const frame = {
    id: frameId,
    type: "frame",
    name: str(params.name) ?? (grid ? "Grid" : "Stack"),
    x: minX - parentAbs.x,
    y: minY - parentAbs.y,
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
    sizing: { height: "fit-content" },
    ...flattenLayout(layout),
    ...(isObj(params.fills) || Array.isArray(params.fills) ? { fills: params.fills } : {}),
    ...(num(params.borderRadius) !== undefined ? { borderRadius: params.borderRadius } : {}),
    children
  } as unknown as DesignElement;

  let list = els;
  for (const id of ids) {
    const [next] = removeElementFromTree(list, id);
    list = next;
  }
  return { els: insertElementIntoContainer(list, frame, parentId ?? undefined), id: frameId };
}

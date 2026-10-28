import { ComponentElement } from "../dsl/types";

/**
 * Definitions that were taken out of the document during this session.
 *
 * An instance addresses its main component by id, from anywhere in the file, so
 * removing the definition is the one edit that silently empties every instance of
 * it — they have no children of their own to fall back on. Cutting a component is
 * the obvious case: the definition is only in the clipboard for the seconds
 * between the cut and the paste, and the user watches every instance of it go
 * blank in the meantime.
 *
 * So the definition is held here, in memory, for the session. The renderer falls
 * back to it while the document has no master under that id; the moment the paste
 * puts the real one back, the document wins and this is never consulted. Nothing
 * here is written to the file: it is a tolerance, not a second source of truth,
 * and a reload is what commits a deletion.
 */
const held = new Map<string, ComponentElement>();

export function holdMaster(el: ComponentElement): void {
  held.set(el.id, el);
}

export function releaseMaster(id: string): void {
  held.delete(id);
}

export function clearHeldMasters(): void {
  held.clear();
}

/** The last known definition of `componentId`, for a master the document no longer holds. */
export function heldMaster(componentId: string | undefined | null): ComponentElement | null {
  if (!componentId) return null;
  return held.get(componentId) ?? null;
}

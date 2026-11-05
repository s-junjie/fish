import type { DesignDocument, DesignElement } from "../../core/dsl/types";
import { ancestorChain } from "../../core/interactions/component-swap";

/**
 * The pictures one Export press produces.
 *
 * A selection is a set of layers, not a region: two frames are two images, and
 * cropping them together put whatever sits between them into the file. Each unit
 * is a TOP-MOST selected layer — a child selected alongside its parent is part of
 * the parent's picture, not a picture of its own.
 */
export function exportUnits(doc: DesignDocument, selected: readonly DesignElement[]): DesignElement[] {
  const ids = new Set(selected.map((el) => el.id));
  return selected.filter((el) => !ancestorChain(doc, el.id).slice(0, -1).some((parent) => ids.has(parent.id)));
}

/**
 * One filename stem per unit, in selection order.
 *
 * Two layers can share a name, and two downloads with the same name leave the
 * user one file — so a repeat is numbered. The comparison is case-insensitive
 * because the folder it lands in usually is.
 */
export function exportNames(units: readonly DesignElement[]): string[] {
  const taken = new Map<string, number>();
  return units.map((el) => {
    const base = (el.name || el.type || "layer").replace(/[\\/:*?"<>|]/g, "_").trim() || "layer";
    const key = base.toLowerCase();
    const seen = (taken.get(key) ?? 0) + 1;
    taken.set(key, seen);
    return seen === 1 ? base : `${base}-${seen}`;
  });
}

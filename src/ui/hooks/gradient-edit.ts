import { useEffect, useState } from "preact/hooks";

/**
 * Which fill row is in "gradient edit" — the ColorPanel for that row is open.
 *
 * A module store, not prop drilling: the flag is written deep in the inspector
 * (FillSection) and read on the canvas (SelectionOverlay), and the picker-focus
 * counter set the precedent for cross-cutting UI state that every layer needs
 * to see at once. Null = plain selection, no on-canvas lever.
 */
export interface GradientEditTarget {
  elId: string;
  paintIndex: number;
}

let target: GradientEditTarget | null = null;
const listeners = new Set<() => void>();

export function setGradientEditTarget(next: GradientEditTarget | null) {
  const same =
    target === next ||
    (target &&
      next &&
      target.elId === next.elId &&
      target.paintIndex === next.paintIndex);
  if (same) return;
  target = next;
  listeners.forEach((fn) => fn());
}

export function useGradientEditTarget(): GradientEditTarget | null {
  const [cur, setCur] = useState<GradientEditTarget | null>(target);
  useEffect(() => {
    const fn = () => setCur(target);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return cur;
}

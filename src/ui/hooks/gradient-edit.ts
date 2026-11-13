import { useEffect, useState } from "preact/hooks";
import type { GradientHandle } from "./canvas-gestures/gradient-gesture";

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
  /**
   * Which stack the row belongs to. A gradient is a paint, and a paint can be a
   * fill OR a stroke — the panel has always edited both, but the lever only ever
   * looked at `fills`, so a stroke's gradient had no handles at all.
   */
  stack: "fills" | "strokes";
}

let target: GradientEditTarget | null = null;
const listeners = new Set<() => void>();

/**
 * Which stop the gradient editor is on.
 *
 * Shared because a stop is now selectable from TWO places — the ramp in the
 * panel and the marker on the canvas' axis — and the two must be the same fact.
 * The panel used to own it in `useState`, which made the canvas unable to say
 * "this stop" without inventing a second selection that could disagree.
 */
let stopIndex = 0;
const stopListeners = new Set<() => void>();

export function getGradientStopIndex(): number {
  return stopIndex;
}

export function setGradientStopIndex(next: number) {
  if (stopIndex === next) return;
  stopIndex = next;
  stopListeners.forEach((fn) => fn());
}

export function useGradientStopIndex(): number {
  const [cur, setCur] = useState(stopIndex);
  useEffect(() => {
    const fn = () => setCur(stopIndex);
    stopListeners.add(fn);
    return () => stopListeners.delete(fn);
  }, []);
  return cur;
}

/**
 * How many gradient colour panels are open, and the delete hand-off between the
 * shortcut and the panel.
 *
 * The shortcut cannot remove a stop itself: the stops live in whichever paint
 * the panel is editing, and the panel is the only surface that knows where that
 * is. So the key asks the panel to do it. While a gradient panel is up the key
 * is ALWAYS theirs — deleting the layer out from under an open gradient is the
 * one outcome the author cannot undo their way out of, and `Backspace` on a
 * non-editable panel used to do exactly that.
 */
let gradientEditors = 0;
let deleteRequests = 0;
const deleteListeners = new Set<() => void>();

export function setGradientEditorOpen(open: boolean) {
  gradientEditors = Math.max(0, gradientEditors + (open ? 1 : -1));
}

/** True when an open gradient editor took the key. */
export function consumeGradientStopDelete(): boolean {
  if (gradientEditors === 0) return false;
  deleteRequests += 1;
  deleteListeners.forEach((fn) => fn());
  return true;
}

export function useGradientStopDeleteRequest(): number {
  const [cur, setCur] = useState(deleteRequests);
  useEffect(() => {
    const fn = () => setCur(deleteRequests);
    deleteListeners.add(fn);
    return () => deleteListeners.delete(fn);
  }, []);
  return cur;
}

export function setGradientEditTarget(next: GradientEditTarget | null) {
  const same =
    target === next ||
    (target &&
      next &&
      target.elId === next.elId &&
      target.paintIndex === next.paintIndex &&
      target.stack === next.stack);
  if (same) return;
  // A different paint starts at its first stop: carrying index 2 into a ramp
  // with two stops would silently edit a stop the author never chose.
  setGradientStopIndex(0);
  target = next;
  listeners.forEach((fn) => fn());
}

export function getGradientEditTarget(): GradientEditTarget | null {
  return target;
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

/**
 * The drag in flight, in the element's own unrotated box.
 *
 * The gesture already knows the pointer in exactly the space the overlay draws
 * in, and a readout is the one piece of feedback the panel cannot give: it sits
 * on another surface, often under the pointer or off the viewport. The store
 * carries the POSITION, not the value — the value is derived from the live paint
 * by the overlay, so a readout cannot disagree with what the canvas is painting.
 */
export interface GradientDragState {
  elId: string;
  paintIndex: number;
  handle: GradientHandle;
  x: number;
  y: number;
}

let drag: GradientDragState | null = null;
const dragListeners = new Set<() => void>();

const sameDrag = (a: GradientDragState | null, b: GradientDragState | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.elId === b.elId &&
    a.paintIndex === b.paintIndex &&
    a.handle === b.handle &&
    a.x === b.x &&
    a.y === b.y);

export function setGradientDrag(next: GradientDragState | null) {
  if (sameDrag(drag, next)) return;
  drag = next;
  dragListeners.forEach((fn) => fn());
}

export function useGradientDrag(): GradientDragState | null {
  const [cur, setCur] = useState<GradientDragState | null>(drag);
  useEffect(() => {
    const fn = () => setCur(drag);
    dragListeners.add(fn);
    return () => dragListeners.delete(fn);
  }, []);
  return cur;
}

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { deepEqual } from "../../core/deep-equal";
import { registerDraftUndo } from "./draft-undo";

const DRAFT_HISTORY_LIMIT = 100;

interface UseDraftHistoryOptions {
  /** Register this draft stack as the active ⌘Z target while `true`. */
  active?: boolean;
}

/**
 * Local undo/redo history for modal draft editors that only commit to the
 * document on Save. Mirrors `EditorStore`'s gesture bracketing so a continuous
 * scrub or picker drag collapses into a single undo step.
 */
export function useDraftHistory<T>(
  initial: T | (() => T),
  options?: UseDraftHistoryOptions
) {
  const active = options?.active ?? true;
  const [value, setValue] = useState<T>(initial);
  const currentRef = useRef<T>(value);
  currentRef.current = value;

  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const gestureInitialRef = useRef<T | null>(null);

  const pushPast = (snapshot: T) => {
    pastRef.current.push(snapshot);
    if (pastRef.current.length > DRAFT_HISTORY_LIMIT) pastRef.current.shift();
    futureRef.current = [];
  };

  const set = useCallback(
    (updater: T | ((prev: T) => T), discrete = true) => {
      const prev = currentRef.current;
      const next = typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
      if (discrete && !deepEqual(next, prev)) {
        gestureInitialRef.current = null;
        pushPast(prev);
      }
      currentRef.current = next;
      setValue(next);
    },
    []
  );

  const startGesture = useCallback(() => {
    if (gestureInitialRef.current === null) {
      gestureInitialRef.current = currentRef.current;
    }
  }, []);

  const endGesture = useCallback(() => {
    const initialSnap = gestureInitialRef.current;
    if (initialSnap === null) return;
    gestureInitialRef.current = null;
    if (!deepEqual(initialSnap, currentRef.current)) {
      pushPast(initialSnap);
    }
  }, []);

  const undo = useCallback((): boolean => {
    gestureInitialRef.current = null;
    const prev = pastRef.current.pop();
    if (prev === undefined) return false;
    futureRef.current.push(currentRef.current);
    currentRef.current = prev;
    setValue(prev);
    return true;
  }, []);

  const redo = useCallback((): boolean => {
    gestureInitialRef.current = null;
    const next = futureRef.current.pop();
    if (next === undefined) return false;
    pastRef.current.push(currentRef.current);
    currentRef.current = next;
    setValue(next);
    return true;
  }, []);

  const reset = useCallback((next: T) => {
    pastRef.current = [];
    futureRef.current = [];
    gestureInitialRef.current = null;
    currentRef.current = next;
    setValue(next);
  }, []);

  useEffect(() => {
    if (!active) return;
    return registerDraftUndo({ undo, redo });
  }, [active, undo, redo]);

  return { value, set, startGesture, endGesture, undo, redo, reset };
}

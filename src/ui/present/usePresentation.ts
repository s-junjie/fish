import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DesignDocument, SlideSpec } from "../../core/dsl/types";
import { PresentationFrame, presentationFrames, findPresentationSlideIndex } from "../../core/presentation/frames";
import { ResolvedSlide, createSlideClock, resolveStep } from "../../core/presentation/slide";
import { t } from "../../i18n";
import { PresentationKeys } from "./presentKeys";

export interface PresentTransition {
  /** The slide being left. Null whenever no transition is on screen. */
  outgoing: PresentationFrame | null;
  /** Eased 0..1 progress of the incoming slide. */
  progress: number;
  /** How the incoming slide is painted; null at rest. */
  motion: ResolvedSlide | null;
}

export interface PresentHost {
  active: boolean;
  index: number;
  total: number;
  frame: PresentationFrame | null;
  transition: PresentTransition;
  /** Handed to the shortcut layer while active. */
  keys: PresentationKeys;
  /** Opens the deck, or says why it cannot. */
  start: () => void;
  toggle: () => void;
}

/** The slide spec of a frame, or nothing for the synthetic page slide. */
function specOf(frame: PresentationFrame | null): SlideSpec | undefined {
  if (!frame || frame.elements.length !== 1) return undefined;
  return (frame.elements[0] as { slide?: SlideSpec }).slide;
}

/**
 * Presentation is a mode of the *viewer*, not of the document: nothing here is
 * committed, and nothing about a slide is stored. That is what keeps it out of
 * undo, autosave and the dialect — and it is why the deck cannot be reordered
 * yet. When it can be, the frames come from `presentationFrames` and this hook
 * does not change.
 *
 * The transition clock lives here rather than in the overlay because the keys do
 * too, and `busy` below is the one gate every move passes: a click, a wheel step
 * and the arrow key beside it all land in `goTo`, so a deck that swallowed one
 * and not another would advance two slides when you meant one.
 */
export function usePresentation(
  doc: DesignDocument,
  primarySelectedId: string | null,
  showHint: (message: string) => void
): PresentHost {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [outgoing, setOutgoing] = useState<PresentationFrame | null>(null);
  const [progress, setProgress] = useState(1);
  const [motion, setMotion] = useState<ResolvedSlide | null>(null);

  // Derived, not snapshotted at `start()`. The overlay mounts a `DocumentStage`
  // that culls and builds defs from the LIVE `allElements` and `docRef`, so a
  // deck holding the element references it captured on entry would pair one
  // revision's tree with another revision's defs — the exact drift
  // `DocumentStage` exists to prevent, reintroduced through the host.
  const frames = useMemo(() => (active ? presentationFrames(doc) : []), [active, doc]);

  const clock = useMemo(() => createSlideClock(), []);
  const frameRef = useRef(0);
  const busy = useRef(false);

  // A mirror of `index`, not a replacement for it. `goTo` is reached from a
  // window-level listener, so two keydowns can arrive inside one render: a
  // `setIndex(i => ...)` reads the newest state whatever the closure saw, while
  // a captured `index` makes the second press compute its target from a slide the
  // deck already left — `Alt+→` then `Alt+←` would drop the second and strand
  // the deck one slide on. Same rule as `mutateSelected` reading the live
  // selection through a ref.
  const indexRef = useRef(0);
  indexRef.current = index;

  const settle = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    busy.current = false;
    clock.cancel();
    setOutgoing(null);
    setProgress(1);
    setMotion(null);
  }, [clock]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  /**
   * Every move in the deck goes through here. A move DURING a transition is
   * dropped rather than queued: a queue turns a held arrow key into a deck that
   * keeps advancing after you let go, and the two slides it lands on are not the
   * two it animated.
   */
  const goTo = useCallback(
    (target: number) => {
      if (busy.current) return;
      const here = indexRef.current;
      const to = frames[target];
      if (!to || target === here) return;
      const from = frames[here] ?? null;

      const resolved = resolveStep(specOf(to), specOf(from), target < here);
      if (!from || resolved.durationMs === 0) {
        setIndex(target);
        return;
      }

      busy.current = true;
      setOutgoing(from);
      setProgress(0);
      setMotion(resolved);
      setIndex(target);
      clock.begin(performance.now(), resolved.durationMs, resolved.easing);

      const tick = (now: number) => {
        const p = clock.advance(now);
        setProgress(p);
        if (!clock.active) settle();
        else frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    },
    [clock, frames, settle]
  );

  const exit = useCallback(() => {
    settle();
    setActive(false);
  }, [settle]);
  // Read through the mirror, so none of these changes identity as the deck moves
  // and the shortcut layer registers its listener once.
  const next = useCallback(() => goTo(indexRef.current + 1), [goTo]);
  const prev = useCallback(() => goTo(indexRef.current - 1), [goTo]);
  const first = useCallback(() => goTo(0), [goTo]);
  const last = useCallback(() => goTo(frames.length - 1), [goTo, frames.length]);

  // Stable so the shortcut layer does not re-register on every render.
  const keys = useMemo<PresentationKeys>(() => ({ next, prev, first, last, exit }), [next, prev, first, last, exit]);

  const start = useCallback(() => {
    const list = presentationFrames(doc);
    if (list.length === 0) {
      showHint(t("present.empty"));
      return;
    }
    // Begin on the artboard holding the selection, so "present this frame" works
    // without hunting for it in the deck. Climbing to the top-level container is
    // what makes that work for a child: after clicking into a frame the
    // selection is a node inside it, and that id is not a slide at all.
    const at = findPresentationSlideIndex(list, doc, primarySelectedId);
    setIndex(at);
    setActive(true);
  }, [doc, primarySelectedId, showHint]);

  const toggle = useCallback(() => {
    if (active) exit();
    else start();
  }, [active, exit, start]);

  const transition = useMemo<PresentTransition>(
    () => ({ outgoing, progress, motion }),
    [outgoing, progress, motion]
  );

  return { active, index, total: frames.length, frame: frames[index] ?? null, transition, keys, start, toggle };
}

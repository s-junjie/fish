import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DesignDocument, Page, SlideSpec, getActivePage } from "../../core/dsl/types";
import { PresentationFrame, presentationFrames, presentablePages, findPresentationSlideIndex } from "../../core/presentation/frames";
import { ResolvedSlide, createSlideClock, resolveStep } from "../../core/presentation/slide";
import { isLaidOut, relayoutDocumentTree } from "../../core/compile";
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

/** One row of the deck's page menu. */
export interface PresentPageEntry {
  id: string;
  name: string;
}

export interface PresentHost {
  active: boolean;
  index: number;
  total: number;
  frame: PresentationFrame | null;
  /** The page being played — the document's active page unless the deck switched. */
  page: Page;
  /** The pages the deck can be switched to, in document order. Empty while closed. */
  pages: PresentPageEntry[];
  transition: PresentTransition;
  /** Handed to the shortcut layer while active. */
  keys: PresentationKeys;
  /** Opens the deck, or says why it cannot. */
  start: () => void;
  toggle: () => void;
  /** Switches the page being played. Commits nothing — not even `activePageId`. */
  selectPage: (pageId: string) => void;
}

/** The slide spec of a frame, or nothing for the synthetic page slide. */
function specOf(frame: PresentationFrame | null): SlideSpec | undefined {
  if (!frame || frame.elements.length !== 1) return undefined;
  return (frame.elements[0] as { slide?: SlideSpec }).slide;
}

/**
 * Presentation is a mode of the *viewer*, not of the document: no slide, no
 * order and no page is committed by it, which is what keeps a deck out of undo,
 * autosave and the dialect. The one setting the deck does write is
 * `canvas.presentBackground`, through its host — a backdrop chosen while
 * presenting has to survive to the next presentation, or it is a switch nobody
 * would use twice.
 *
 * The transition clock lives here rather than in the overlay because the keys do
 * too, and `busy` below is the one gate every move passes: a click, a wheel step
 * and the arrow key beside it all land in `goTo`, so a deck that swallowed one
 * and not another would advance two slides when you meant one.
 */
export function usePresentation(
  doc: DesignDocument,
  primarySelectedId: string | null,
  showHint: (message: string) => void,
  page?: Page,
  /** Told which page the deck moved to, so a host that owns page state can follow. */
  onPageChange?: (pageId: string) => void
): PresentHost {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  /** The page the deck switched to, or null while it plays its host's page. */
  const [pageId, setPageId] = useState<string | null>(null);
  const [outgoing, setOutgoing] = useState<PresentationFrame | null>(null);
  const [progress, setProgress] = useState(1);
  const [motion, setMotion] = useState<ResolvedSlide | null>(null);

  // `page` is the host's own page when it is showing one the document is not on:
  // the phone reader switches pages without committing `activePageId`, so a deck
  // built from `getActivePage` would play a different page than the one on screen.
  const hostPage = page ?? getActivePage(doc);
  const picked = useMemo(() => {
    if (!pageId || pageId === hostPage.id) return hostPage;
    return doc.pages?.find((p) => p.id === pageId) ?? hostPage;
  }, [doc, pageId, hostPage]);

  /**
   * The page as the stage should draw it.
   *
   * A page the host is not showing has never been through the layout pass — the
   * editor compiles only the page it draws — so it is reflowed into a memo rather
   * than into the document. Presenting a page is not editing it.
   */
  const playedPage = useMemo(() => {
    const children = picked.children ?? [];
    return isLaidOut(children) ? picked : { ...picked, children: relayoutDocumentTree(children) };
  }, [picked]);

  // Derived, not snapshotted at `start()`. The overlay mounts a `DocumentStage`
  // that culls and builds defs from the LIVE `docRef`, so a deck holding the
  // element references it captured on entry would pair one revision's tree with
  // another revision's defs — the exact drift `DocumentStage` exists to prevent,
  // reintroduced through the host.
  const frames = useMemo(() => (active ? presentationFrames(doc, playedPage) : []), [active, doc, playedPage]);

  const deckPages = useMemo<PresentPageEntry[]>(
    () => (active ? presentablePages(doc).map((p) => ({ id: p.id, name: p.name })) : []),
    [active, doc]
  );

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

  /**
   * A page switch is not a step: it settles whatever transition is on screen and
   * lands on the new page's FIRST slide, because a transition describes a move
   * between two slides of one deck — the outgoing slide belongs to a page that is
   * no longer loaded.
   */
  const selectPage = useCallback(
    (nextPageId: string) => {
      if (nextPageId === playedPage.id) return;
      if (!doc.pages?.some((p) => p.id === nextPageId)) return;
      settle();
      indexRef.current = 0;
      setIndex(0);
      setPageId(nextPageId);
      onPageChange?.(nextPageId);
    },
    [doc, playedPage.id, settle, onPageChange]
  );

  const start = useCallback(() => {
    // A fresh deck starts on the page the host is on: the switch is a move inside
    // one presentation, not a page the document remembers.
    setPageId(null);
    const list = presentationFrames(doc, page ?? getActivePage(doc));
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
  }, [doc, page, primarySelectedId, showHint]);

  const toggle = useCallback(() => {
    if (active) exit();
    else start();
  }, [active, exit, start]);

  const transition = useMemo<PresentTransition>(
    () => ({ outgoing, progress, motion }),
    [outgoing, progress, motion]
  );

  return {
    active,
    index,
    total: frames.length,
    frame: frames[index] ?? null,
    page: playedPage,
    pages: deckPages,
    transition,
    keys,
    start,
    toggle,
    selectPage
  };
}

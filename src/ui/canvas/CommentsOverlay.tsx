import { useState, useRef, useEffect, useLayoutEffect } from "preact/hooks";
import { MessageSquare, Sparkles, AlertCircle, Check } from "lucide-react";
import { t } from "../../i18n";
import { DARK_RING_CLASS } from "../ring-style";
import {
  resolveCommentCanvasPoint,
  canvasToViewportPoint,
  computeRelativeOffset,
  type ElementBounds
} from "../../core/comments/anchor";
import { suggestionElementIds } from "../../core/comments/diff";
import type { FishCommentsDocument, CommentTarget } from "../../core/comments/types";
import type { DesignDocument } from "../../core/dsl/types";
import { CommentPopover } from "./CommentPopover";
import { CommentPortal } from "./comment-portal";
import { CommentComposer } from "../comments/CommentComposer";

const POPOVER_WIDTH = 360;
/** Pin size in px (w-7 h-7 = 28px). The 2px bottom-left beak corner sits at (0, 28). */
const PIN_SIZE = 28;

/** Sub-pixel noise must not re-render the whole overlay. */
function samePx(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}

export interface CommentsOverlayProps {
  comments: FishCommentsDocument;
  pageId: string;
  viewport: { panX: number; panY: number; zoom: number };
  findElement: (elementId: string) => CommentHitBox | undefined;
  onAddComment: (target: CommentTarget, content: string) => void;
  onReplyComment: (threadId: string, content: string) => void;
  onResolveComment: (threadId: string) => void;
  onReopenComment: (threadId: string) => void;
  onDeleteComment: (threadId: string) => void;
  onMoveComment?: (threadId: string, target: CommentTarget) => void;
  onApplySuggestion?: (threadId: string) => void;
  onDiscardSuggestion?: (threadId: string) => void;
  draftTarget?: CommentTarget | null;
  setDraftTarget?: (target: CommentTarget | null) => void;
  activeThreadId?: string | null;
  setActiveThreadId?: (id: string | null) => void;
  /** Live document: the popover reads the suggestion's real property diff. */
  docRef?: { current: DesignDocument };
  /** Puts an applied copy of the suggestion on the canvas, or takes it off. */
  onSetPreview?: (doc: DesignDocument | null) => void;
  /** Hide-UI mode (Tab): pins are chrome, and the canvas becomes the artwork. */
  hidden?: boolean;
}

/** The world box plus what a pin needs to describe its new host. */
export interface CommentHitBox extends ElementBounds {
  name?: string;
  type?: string;
}

export function CommentsOverlay({
  comments,
  pageId,
  viewport,
  findElement,
  onAddComment,
  onReplyComment,
  onResolveComment,
  onReopenComment,
  onDeleteComment,
  onMoveComment,
  onApplySuggestion,
  onDiscardSuggestion,
  draftTarget: propsDraftTarget,
  setDraftTarget: propsSetDraftTarget,
  activeThreadId: propsActiveThreadId,
  setActiveThreadId: propsSetActiveThreadId,
  docRef,
  hidden = false,
  onSetPreview
}: CommentsOverlayProps) {
  const [internalActiveThreadId, setInternalActiveThreadId] = useState<string | null>(null);
  const [internalDraftTarget, setInternalDraftTarget] = useState<CommentTarget | null>(null);

  const activeThreadId = propsActiveThreadId !== undefined ? propsActiveThreadId : internalActiveThreadId;
  const setActiveThreadId = propsSetActiveThreadId ?? setInternalActiveThreadId;

  const draftTarget = propsDraftTarget !== undefined ? propsDraftTarget : internalDraftTarget;
  const setDraftTarget = propsSetDraftTarget ?? setInternalDraftTarget;

  const [draftContent, setDraftContent] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState({ left: 0, top: 0 });

  const [drag, setDrag] = useState<{
    threadId: string;
    clientX: number;
    clientY: number;
    hitId: string | null;
  } | null>(null);
  const dragRef = useRef<{ threadId: string; startX: number; startY: number; moved: boolean } | null>(null);

  /* The cards are drawn in the body, so a canvas point has to become a window
     point. The overlay covers exactly the canvas box, which makes its own rect
     that conversion — measured rather than passed, so a rail resize or a title
     bar that grows moves the pins with it. */
  useLayoutEffect(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setOrigin((prev) =>
      samePx(prev.left, rect.left) && samePx(prev.top, rect.top)
        ? prev
        : { left: rect.left, top: rect.top }
    );
  }, [viewport]);

  // A new pin starts a new comment: text typed against the previous target is
  // not that target's comment.
  useEffect(() => {
    setDraftContent("");
  }, [draftTarget]);

  const pageThreads = comments.threads.filter((t) => t.pageId === pageId);
  const activeThread = pageThreads.find((t) => t.id === activeThreadId) ?? null;

  /* Resolved threads keep no pin at rest: the canvas is what the design looks
     like. Opening one from the rail puts its pin back, so the card is not
     floating over an unmarked spot. */
  const pinThreads = pageThreads.filter(
    (thread) => thread.status !== "resolved" || thread.id === activeThreadId
  );

  const clientToCanvas = (clientX: number, clientY: number) => ({
    x: (clientX - origin.left - viewport.panX) / viewport.zoom,
    y: (clientY - origin.top - viewport.panY) / viewport.zoom
  });

  const elementAt = (clientX: number, clientY: number): string | null => {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const node of stack) {
      const el = node as HTMLElement;
      if (el.closest?.("[data-comment-pin],[data-ui-layer=comments-overlay]")) continue;
      const id = el.closest?.("[data-element-id]")?.getAttribute("data-element-id");
      if (id && findElement(id)) return id;
    }
    return null;
  };

  const startPinDrag = (threadId: string, e: PointerEvent) => {
    if (!onMoveComment) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { threadId, startX: e.clientX, startY: e.clientY, moved: false };

    const onMove = (move: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (
        !current.moved &&
        Math.abs(move.clientX - current.startX) < 3 &&
        Math.abs(move.clientY - current.startY) < 3
      ) {
        return;
      }
      current.moved = true;
      setDrag({
        threadId: current.threadId,
        clientX: move.clientX,
        clientY: move.clientY,
        hitId: elementAt(move.clientX, move.clientY)
      });
    };

    const onUp = (up: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current) return;

      if (!current.moved) {
        setDraftTarget(null);
        setActiveThreadId(activeThreadId === current.threadId ? null : current.threadId);
        return;
      }

      const point = clientToCanvas(up.clientX, up.clientY);
      const hitId = elementAt(up.clientX, up.clientY);
      const box = hitId ? findElement(hitId) : undefined;
      const target: CommentTarget =
        hitId && box
          ? {
              elementId: hitId,
              relativeOffset: computeRelativeOffset(point, box),
              canvasPoint: point,
              elementSnapshot: { name: box.name ?? hitId, type: box.type ?? "element" }
            }
          : { canvasPoint: point };
      onMoveComment(current.threadId, target);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /* A press anywhere outside the open comment windows closes them, and — when it
     lands on the canvas — does nothing else. Comment mode is a mode: without
     this, the press that dismisses a card also opens a new draft under it,
     which never looks like the dismiss the user intended. */
  const hasOpenCard = Boolean(activeThread || draftTarget);
  useEffect(() => {
    if (!hasOpenCard || typeof document === "undefined") return;
    const closeAll = () => {
      setActiveThreadId(null);
      setDraftTarget(null);
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // The pins toggle themselves; the rail is where the next thread is
      // chosen, so a press there belongs to the row, not to this dismissal.
      if (
        target.closest(
          "[data-ui-panel=comment-popover],[data-ui-panel=comment-composer],[data-comment-pin],[data-ui-panel=right]"
        )
      ) {
        return;
      }
      closeAll();
      if (target.closest("[data-canvas-root]")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [hasOpenCard, setActiveThreadId, setDraftTarget]);

  /**
   * A canvas point as a window point. The overlay covers exactly the canvas
   * box, so its own rect is the conversion — measured rather than handed in, so
   * a resized rail or a taller title bar moves the cards with the pins.
   */
  const toWindowPoint = (target: CommentTarget) => {
    const point = resolveCommentCanvasPoint(target, findElement);
    const screen = canvasToViewportPoint(point, viewport);
    return { x: origin.left + screen.x, y: origin.top + screen.y };
  };

  const handleCreateDraft = () => {
    const trimmed = draftContent.trim();
    if (!trimmed || !draftTarget) return;
    onAddComment(draftTarget, trimmed);
    setDraftTarget(null);
  };

  const suggestedIds =
    activeThread && activeThread.status === "suggested" && activeThread.suggestion
      ? suggestionElementIds(activeThread.suggestion.ops)
      : [];

  const draftPoint = draftTarget
    ? canvasToViewportPoint(resolveCommentCanvasPoint(draftTarget, findElement), viewport)
    : null;

  /* Hide-UI is a look at the artwork alone, so pins, ghosts and the portalled
     cards all go with the rails. State is kept: coming back restores the open
     card instead of asking the user to find it again. */
  if (hidden) {
    return <div ref={rootRef} data-ui-layer="comments-overlay" className="absolute inset-0 pointer-events-none" />;
  }

  return (
    <div
      ref={rootRef}
      data-ui-layer="comments-overlay"
      className="absolute inset-0 pointer-events-none overflow-hidden z-30"
    >
      {/* What an AI suggestion will touch, drawn over the artwork it would
          change — the review card lists properties, this says which layer. */}
      {suggestedIds.map((id) => {
        const box = findElement(id);
        if (!box) return null;
        const topLeft = canvasToViewportPoint({ x: box.x, y: box.y }, viewport);
        return (
          <div
            key={`ghost_${id}`}
            data-comment-ghost={id}
            style={{
              transform: `translate3d(${topLeft.x}px, ${topLeft.y}px, 0)`,
              width: `${box.width * viewport.zoom}px`,
              height: `${box.height * viewport.zoom}px`
            }}
            className="absolute left-0 top-0 border border-dashed border-brand rounded-sm pointer-events-none"
          />
        );
      })}

      {pinThreads.map((thread, index) => {
        const point = resolveCommentCanvasPoint(thread.target, findElement);
        const screenPt = canvasToViewportPoint(point, viewport);
        const isSuggested = thread.status === "suggested";
        const isResolved = thread.status === "resolved";
        const isSelected = activeThreadId === thread.id;
        const isDragging = drag?.threadId === thread.id;
        const x = isDragging ? drag.clientX - origin.left : screenPt.x;
        const y = isDragging ? drag.clientY - origin.top : screenPt.y;
        /* Solid brand marks what is in hand — the pin being edited and a proposal
           awaiting a decision; a resting conversation is the same chip outlined. */
        const isSolid = !isResolved && (isSelected || isSuggested);
        const face = isSolid
          ? "bg-brand text-brand-ink"
          : isResolved
          ? "bg-raised text-ink-muted border border-rule"
          : "bg-surface text-ink border-2 border-brand";
        const selectedRing = isSelected
          ? "ring-2 ring-brand ring-offset-1 ring-offset-surface"
          : "";

        return (
          <button
            key={thread.id}
            type="button"
            data-comment-pin={thread.id}
            style={{ transform: `translate3d(${x}px, ${y - PIN_SIZE}px, 0)` }}
            className={`absolute left-0 top-0 p-0 bg-transparent border-0 select-none ${
              isDragging ? "pointer-events-none cursor-grabbing z-40" : "pointer-events-auto cursor-grab"
            }`}
            aria-label={t("comments.pinLabel", { n: index + 1 })}
            onPointerDown={(e) => startPinDrag(thread.id, e)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              setDraftTarget(null);
              setActiveThreadId(isSelected ? null : thread.id);
            }}
          >
            <div
              style={{ borderRadius: "14px 14px 14px 2px", transformOrigin: `0 ${PIN_SIZE}px` }}
              className={`w-7 h-7 flex items-center justify-center select-none transition-transform ${DARK_RING_CLASS} ${
                isSelected ? "scale-110" : ""
              } ${selectedRing} ${face}`}
            >
              {isSuggested ? (
                <Sparkles size={12} className={isSolid ? "text-brand-ink" : "text-brand"} />
              ) : isResolved ? (
                <Check size={12} className="text-ink-muted" />
              ) : point.isOrphan ? (
                <AlertCircle size={12} className={isSolid ? "text-brand-ink" : "text-measure-coral"} />
              ) : (
                <span className="font-mono text-meta font-medium select-none">{index + 1}</span>
              )}
            </div>
          </button>
        );
      })}

      {drag?.hitId && (() => {
        const box = findElement(drag.hitId);
        if (!box) return null;
        const topLeft = canvasToViewportPoint({ x: box.x, y: box.y }, viewport);
        return (
          <div
            data-comment-drop-target={drag.hitId}
            style={{
              transform: `translate3d(${topLeft.x}px, ${topLeft.y}px, 0)`,
              width: `${box.width * viewport.zoom}px`,
              height: `${box.height * viewport.zoom}px`
            }}
            className="absolute left-0 top-0 border-2 border-canvas-select rounded-sm pointer-events-none"
          />
        );
      })()}

      {activeThread && (
        <CommentPortal anchor={toWindowPoint(activeThread.target)} width={POPOVER_WIDTH}>
          <CommentPopover
            thread={activeThread}
            docRef={docRef}
            onSetPreview={onSetPreview}
            isOrphan={resolveCommentCanvasPoint(activeThread.target, findElement).isOrphan}
            onReply={onReplyComment}
            onResolve={(id) => {
              onResolveComment(id);
              setActiveThreadId(null);
            }}
            onReopen={onReopenComment}
            onDelete={(id) => {
              onDeleteComment(id);
              setActiveThreadId(null);
            }}
            onClose={() => setActiveThreadId(null)}
            onApplySuggestion={onApplySuggestion}
            onDiscardSuggestion={onDiscardSuggestion}
          />
        </CommentPortal>
      )}

      {draftTarget && draftPoint && (
        <>
          <div
            data-comment-draft-pin="true"
            style={{
              transform: `translate3d(${draftPoint.x}px, ${draftPoint.y - PIN_SIZE}px, 0)`,
              borderRadius: "14px 14px 14px 2px",
              transformOrigin: `0 ${PIN_SIZE}px`
            }}
            className={`absolute left-0 top-0 w-7 h-7 flex items-center justify-center bg-surface text-brand border-2 border-brand ${DARK_RING_CLASS} pointer-events-none z-40 animate-pulse select-none`}
          >
            <MessageSquare size={12} className="text-brand" />
          </div>
          <CommentPortal anchor={toWindowPoint(draftTarget)} width={POPOVER_WIDTH}>
            <CommentComposer
              targetLabel={
                draftTarget.elementSnapshot?.name ?? draftTarget.elementId ?? t("comments.canvasTarget")
              }
              value={draftContent}
              onInput={setDraftContent}
              onSubmit={handleCreateDraft}
              onCancel={() => setDraftTarget(null)}
            />
          </CommentPortal>
        </>
      )}
    </div>
  );
}

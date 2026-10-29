import { useState, useRef, useEffect, useMemo, useCallback } from "preact/hooks";
import { Check, Trash2, RotateCcw, AlertCircle, Sparkles, ArrowUp } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { CommentDiffCard } from "../comments/CommentDiffCard";
import { computeSuggestionDiff } from "../../core/comments/diff";
import { applySuggestionToDocument } from "../../core/comments/suggested-ops";
import type { CommentThread } from "../../core/comments/types";
import type { DesignDocument } from "../../core/dsl/types";

export interface CommentPopoverProps {
  thread: CommentThread;
  /** The live document, for reading the suggestion's actual property changes. */
  docRef?: { current: DesignDocument };
  isOrphan?: boolean;
  onReply: (threadId: string, content: string) => void;
  onResolve: (threadId: string) => void;
  onReopen: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onClose: () => void;
  onApplySuggestion?: (threadId: string) => void;
  onDiscardSuggestion?: (threadId: string) => void;
  /** Redirects the canvas to a document read against the live one, or back. */
  onSetPreview?: (doc: DesignDocument | null) => void;
}

const STATUS_DOT_CLASS: Record<CommentThread["status"], string> = {
  open: "bg-brand",
  suggested: "bg-brand",
  resolved: "bg-ink-muted",
  archived: "bg-ink-muted"
};

export function CommentPopover({
  thread,
  docRef,
  isOrphan,
  onReply,
  onResolve,
  onReopen,
  onDelete,
  onClose,
  onApplySuggestion,
  onDiscardSuggestion,
  onSetPreview
}: CommentPopoverProps) {
  const [replyText, setReplyText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus?.();
  }, [thread.id]);

  const isResolved = thread.status === "resolved";
  const suggestion = thread.suggestion;
  const isPendingSuggestion = thread.status === "suggested" && Boolean(suggestion);

  const freshRows = isPendingSuggestion && docRef && suggestion
    ? computeSuggestionDiff(
        docRef.current,
        { pageId: thread.pageId, elementId: thread.target.elementId },
        suggestion.ops
      )
    : [];
  /* A preview redirects the document the rows are read off, so recomputing them
     would diff the ops against their own output and report "no changes" — which
     reads as a broken Accept. The evidence is frozen at what the user agreed to. */
  const frozenRows = useRef<typeof freshRows>([]);
  const [previewing, setPreviewing] = useState(false);
  if (!previewing) frozenRows.current = freshRows;
  const diffRows = previewing ? frozenRows.current : freshRows;

  const canPreview = useMemo(() => {
    if (!docRef || !suggestion) return false;
    return applySuggestionToDocument(docRef.current, suggestion.ops).changed;
  }, [docRef, suggestion]);

  const exitPreview = useCallback(() => {
    setPreviewing(false);
    onSetPreview?.(null);
  }, [onSetPreview]);

  /* The preview has no life of its own outside this thread's card: switching
     threads, closing the card, or accepting/discarding take the canvas back. */
  useEffect(() => {
    setPreviewing(false);
    onSetPreview?.(null);
  }, [thread.id]);
  useEffect(() => () => onSetPreview?.(null), [onSetPreview]);
  useEffect(() => {
    if (!isPendingSuggestion && previewing) exitPreview();
  }, [isPendingSuggestion, previewing, exitPreview]);

  const togglePreview = () => {
    if (!docRef || !suggestion) return;
    if (previewing) {
      exitPreview();
      return;
    }
    const { nextDoc, changed } = applySuggestionToDocument(docRef.current, suggestion.ops);
    if (!changed) return;
    setPreviewing(true);
    onSetPreview?.(nextDoc);
  };

  const handleApply = () => {
    // Writes are refused while the view is redirected, so the preview has to go
    // before the commit — not in an effect that would land after it.
    exitPreview();
    onApplySuggestion?.(thread.id);
  };

  const handleSend = () => {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply(thread.id, trimmed);
    // A reply on a resolved thread is the user disagreeing with the resolve, so
    // the thread comes back to open — otherwise the answer lands on a card that
    // says "Resolved" above it and disappears from the open list.
    if (isResolved) onReopen(thread.id);
    setReplyText("");
    onClose();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const targetName =
    thread.target.elementSnapshot?.name ?? thread.target.elementId ?? t("comments.canvasTarget");

  const lastMessage = thread.messages[thread.messages.length - 1]?.content ?? "";

  return (
    <div
      data-ui-panel="comment-popover"
      data-thread-id={thread.id}
      className={`${POPOVER_SURFACE_CLASS} px-2.5 pt-2 pb-2.5 flex flex-col gap-2 font-sans text-ui text-ink`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {/* The title is the LAYER, not "Comment": what the card is about is the
          only thing that tells two open threads apart. The whole row is the drag
          handle, so it doubles as the window's gripper. */}
      <div data-comment-drag-handle="true" className="min-w-0 cursor-grab active:cursor-grabbing">
        <PanelHeader
          title={
            <span className="flex items-center gap-1.5 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT_CLASS[thread.status]}`} />
              <span className="truncate">{targetName}</span>
              {isOrphan && (
                <span className="text-measure-coral shrink-0" title={t("comments.orphanNotice")}>
                  <AlertCircle size={11} />
                </span>
              )}
            </span>
          }
          titleClassName="min-w-0 truncate"
          onClose={onClose}
          actions={
            <>
              {isResolved ? (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => onReopen(thread.id)}
                  title={t("comments.reopen")}
                  aria-label={t("comments.reopen")}
                >
                  <RotateCcw size={13} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    onResolve(thread.id);
                    onClose();
                  }}
                  title={t("comments.resolve")}
                  aria-label={t("comments.resolve")}
                >
                  <Check size={13} />
                </Button>
              )}
              <Button
                size="icon"
                variant="danger"
                onClick={() => onDelete(thread.id)}
                title={t("comments.delete")}
                aria-label={t("comments.delete")}
              >
                <Trash2 size={13} />
              </Button>
            </>
          }
          className="pb-1.5 border-b border-rule"
        />
      </div>

      <div className="flex flex-col gap-3 max-h-56 overflow-y-auto pr-1">
        {thread.messages.map((msg) => {
          const isAi = msg.author.role === "ai";
          const initial = msg.author.name ? msg.author.name.charAt(0).toUpperCase() : (isAi ? "A" : "U");
          return (
            <div key={msg.id} className="flex items-start gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-row font-sans shrink-0 border select-none ${
                  isAi
                    ? "bg-brand-wash text-brand border-brand/30"
                    : "bg-raised text-ink border-rule"
                }`}
              >
                {initial}
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className={`text-row ${isAi ? "text-brand" : "text-ink"}`}>{msg.author.name}</span>
                <p className="text-ink text-ui whitespace-pre-wrap break-words leading-snug">
                  {msg.content}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {suggestion && isPendingSuggestion && (
        <CommentDiffCard
          summary={suggestion.summary}
          rows={diffRows}
          pending
          canPreview={canPreview}
          previewOn={previewing}
          onTogglePreview={togglePreview}
          showSummary={suggestion.summary !== lastMessage}
          onApply={handleApply}
          onDiscard={() => onDiscardSuggestion?.(thread.id)}
        />
      )}

      {/* Once applied, the ops have already been read against the document, so
          recomputing the diff would compare them with their own result and
          report "nothing changed" — which reads as if the accept did nothing. */}
      {suggestion && !isPendingSuggestion && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-ctl bg-raised border border-rule text-row text-ink-muted">
          <Sparkles size={11} className="text-brand shrink-0" />
          <span className="truncate">{t("comments.suggestionApplied")}</span>
        </div>
      )}

      <div className="pt-2 border-t border-rule flex items-end gap-2">
        <div className="w-6 h-6 rounded-full bg-raised border border-rule flex items-center justify-center text-row text-ink font-sans shrink-0 mb-0.5">
          U
        </div>
        <div className="flex-1 min-w-0 relative flex items-center bg-field rounded-full border border-rule focus-within:border-brand transition-colors pl-3 pr-1 py-1">
          <input
            ref={inputRef}
            type="text"
            value={replyText}
            onInput={(e) => setReplyText((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            placeholder={t("comments.replyPlaceholder")}
            aria-label={t("comments.replyPlaceholder")}
            className="w-full bg-transparent text-ui text-ink border-0 p-0 focus:outline-none placeholder:text-ink-muted"
          />
          <button
            type="button"
            disabled={!replyText.trim()}
            onClick={handleSend}
            aria-label={t("comments.send")}
            className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
              replyText.trim()
                ? "bg-brand text-brand-ink hover:brightness-105 cursor-pointer"
                : "bg-raised text-ink-muted opacity-40 cursor-default"
            }`}
          >
            <ArrowUp size={11} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
}

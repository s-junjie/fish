import { useState, useRef, useEffect } from "preact/hooks";
import { Check, Trash2, RotateCcw, AlertCircle, Sparkles } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";
import { POPOVER_SURFACE_CLASS } from "../menu-style";
import { CommentDiffCard } from "../comments/CommentDiffCard";
import { computeSuggestionDiff } from "../../core/comments/diff";
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
  onDiscardSuggestion
}: CommentPopoverProps) {
  const [replyText, setReplyText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus?.();
  }, [thread.id]);

  const isResolved = thread.status === "resolved";
  const suggestion = thread.suggestion;
  const isPendingSuggestion = thread.status === "suggested" && Boolean(suggestion);

  const diffRows = isPendingSuggestion && docRef && suggestion
    ? computeSuggestionDiff(
        docRef.current,
        { pageId: thread.pageId, elementId: thread.target.elementId },
        suggestion.ops
      )
    : [];

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
      className={`${POPOVER_SURFACE_CLASS} px-2.5 pt-2 pb-2.5 flex flex-col gap-2 text-ui text-ink`}
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

      <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
        {thread.messages.map((msg) => {
          const isAi = msg.author.role === "ai";
          return (
            <div key={msg.id} className="flex flex-col gap-0.5">
              <span className={`text-row ${isAi ? "text-brand" : "text-ink"}`}>{msg.author.name}</span>
              <p className="text-ink text-ui whitespace-pre-wrap break-words leading-snug">
                {msg.content}
              </p>
            </div>
          );
        })}
      </div>

      {suggestion && isPendingSuggestion && (
        <CommentDiffCard
          summary={suggestion.summary}
          rows={diffRows}
          pending
          showSummary={suggestion.summary !== lastMessage}
          onApply={() => onApplySuggestion?.(thread.id)}
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

      <div className="flex flex-col gap-1.5 pt-1 border-t border-rule">
        <textarea
          ref={inputRef}
          rows={2}
          value={replyText}
          onInput={(e) => setReplyText((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder={t("comments.replyPlaceholder")}
          aria-label={t("comments.replyPlaceholder")}
          className="w-full bg-field rounded-ctl p-1.5 text-ui text-ink border border-rule resize-none focus:outline-none focus:border-brand"
        />
        <div className="flex items-center justify-end">
          <Button size="field" variant="primary" disabled={!replyText.trim()} onClick={handleSend}>
            {t("comments.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}

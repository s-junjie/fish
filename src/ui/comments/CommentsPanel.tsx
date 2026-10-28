import { useMemo, useState } from "preact/hooks";
import { Sparkles, Check, Trash2, RotateCcw } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { SegmentedControl } from "../SegmentedControl";
import type { CommentThread, FishCommentsDocument } from "../../core/comments/types";

export type CommentFilter = "all" | "open" | "resolved";

export interface CommentsPanelProps {
  comments: FishCommentsDocument;
  /** Threads are per page, like the layer list above them. */
  pageId: string;
  activeThreadId?: string | null;
  onFocusThread: (threadId: string) => void;
  onResolve: (threadId: string) => void;
  onReopen: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}

const EMPTY_HINT_CLASS = "px-2 py-6 text-center text-row leading-snug text-ink-muted select-none";

function ThreadRow({
  thread,
  active,
  onFocus,
  onResolve,
  onReopen,
  onDelete
}: {
  thread: CommentThread;
  active: boolean;
  onFocus: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const last = thread.messages[thread.messages.length - 1];
  const resolved = thread.status === "resolved";
  const pending = thread.status === "suggested" && Boolean(thread.suggestion);

  return (
    <div
      data-comment-row={thread.id}
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus();
        }
      }}
      className={`group relative flex flex-col gap-1 px-2 py-1.5 rounded-ctl cursor-default transition-colors duration-micro ease-snap ${
        active ? "bg-selection" : "hover:bg-selection-subtree-solid"
      }`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            pending ? "bg-brand" : resolved ? "bg-ink-muted" : "bg-brand"
          }`}
        />
        <span className="font-mono text-row text-ink truncate flex-1">
          {thread.target.elementSnapshot?.name ?? thread.target.elementId ?? t("comments.canvasTarget")}
        </span>
        {/* Row actions take the row's right end on hover: two icons beside a
            truncating label would squeeze it, and a 2-line row has no room to
            put them below. */}
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-micro">
          {resolved ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onReopen();
              }}
              title={t("comments.reopen")}
              aria-label={t("comments.reopen")}
            >
              <RotateCcw size={12} />
            </Button>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onResolve();
              }}
              title={t("comments.resolve")}
              aria-label={t("comments.resolve")}
            >
              <Check size={12} />
            </Button>
          )}
          <Button
            size="icon"
            variant="danger"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title={t("comments.delete")}
            aria-label={t("comments.delete")}
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </div>

      <p
        className={`text-ui leading-snug break-words line-clamp-2 ${
          resolved ? "text-ink-muted" : "text-ink-dim"
        }`}
      >
        {last?.content ?? ""}
      </p>

      <div className="flex items-center gap-1.5">
        <span className="text-meta text-ink-muted">
          {(() => {
            const replies = thread.messages.length - 1;
            if (replies <= 0) return t("comments.noReplies");
            return t("comments.replies", { n: replies });
          })()}
        </span>
        {pending && (
          <span className="flex items-center gap-1 text-meta text-brand">
            <Sparkles size={9} />
            {t("comments.aiSuggested")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The comments rail, in the shape Figma uses: every thread on the page, in one
 * list, with the canvas as the other half of the same object.
 *
 * It sits in the left rail rather than the right one because FISH's right rail
 * is the inspector, which is a fixed-width property stack for the selection —
 * comment threads are not properties of the selection and must survive changing
 * it.
 */
export function CommentsPanel({
  comments,
  pageId,
  activeThreadId,
  onFocusThread,
  onResolve,
  onReopen,
  onDelete
}: CommentsPanelProps) {
  const [filter, setFilter] = useState<CommentFilter>("all");

  const pageThreads = useMemo(
    () => comments.threads.filter((thread) => thread.pageId === pageId),
    [comments.threads, pageId]
  );

  const visible = useMemo(() => {
    const match = (thread: CommentThread) =>
      filter === "all"
        ? true
        : filter === "resolved"
        ? thread.status === "resolved"
        : thread.status !== "resolved";
    // Open before resolved, then newest first: the list is a queue of things to
    // act on, not an archive.
    return pageThreads
      .filter(match)
      .slice()
      .sort((a, b) => {
        const aDone = a.status === "resolved" ? 1 : 0;
        const bDone = b.status === "resolved" ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [pageThreads, filter]);

  return (
    <div data-ui-panel="comments" className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 pt-2 pb-1.5 shrink-0">
        <SegmentedControl<CommentFilter>
          value={filter}
          onChange={setFilter}
          className="w-full"
          rowProps={{ "data-comment-filter": "true" }}
          items={[
            { value: "all", label: t("comments.filterAll"), grow: true },
            { value: "open", label: t("comments.filterOpen"), grow: true },
            { value: "resolved", label: t("comments.filterResolved"), grow: true }
          ]}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-0.5">
        {visible.length === 0 ? (
          <p className={EMPTY_HINT_CLASS}>
            {filter === "resolved" ? t("comments.emptyResolved") : t("comments.emptyHint")}
          </p>
        ) : (
          visible.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              active={activeThreadId === thread.id}
              onFocus={() => onFocusThread(thread.id)}
              onResolve={() => onResolve(thread.id)}
              onReopen={() => onReopen(thread.id)}
              onDelete={() => onDelete(thread.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

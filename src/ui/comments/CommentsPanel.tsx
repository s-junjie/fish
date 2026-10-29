import { useMemo, useState } from "preact/hooks";
import { Sparkles, Check, Trash2, RotateCcw } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";
import { SegmentedControl } from "../SegmentedControl";
import type { CommentThread, FishCommentsDocument } from "../../core/comments/types";

export type CommentFilter = "all" | "open" | "resolved";

export interface CommentsPanelProps {
  comments: FishCommentsDocument;
  /** Only used to mark the rows that are not on the canvas the user is looking at. */
  pageId: string;
  /** Page names are on the document, which the panel is deliberately not handed. */
  pageNames: Record<string, string>;
  activeThreadId?: string | null;
  /**
   * Every row is a jump, including across pages: selecting a thread has to
   * switch page, bring its pin into view and open its card, or the click would
   * land on a pin the user cannot see.
   */
  onFocusThread: (threadId: string) => void;
  onResolve: (threadId: string) => void;
  onReopen: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}

const EMPTY_HINT_CLASS = "px-2 py-6 text-center text-row leading-snug text-ink-muted select-none";

function ThreadRow({
  thread,
  active,
  pageLabel,
  onFocus,
  onResolve,
  onReopen,
  onDelete
}: {
  thread: CommentThread;
  active: boolean;
  /** Undefined on a single-page document, where every row is on this canvas. */
  pageLabel?: string;
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
      className={`group relative flex flex-col gap-1 px-2 py-2 rounded-ctl cursor-default font-sans transition-colors duration-micro ease-snap ${
        active ? "bg-selection" : "hover:bg-selection-subtree-solid"
      }`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            pending ? "bg-brand" : resolved ? "bg-ink-muted" : "bg-brand"
          }`}
        />
        <span className="text-row text-ink truncate flex-1">
          {thread.target.elementSnapshot?.name ?? thread.target.elementId ?? t("comments.canvasTarget")}
        </span>
        {/* Row actions take the row's right end on hover: two icons beside a
            truncating label would squeeze it, and a 2-line row has no room to
            put them below. */}
        <div className="absolute right-1.5 top-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-micro">
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
        {pageLabel && (
          <span className={`${SUB_LABEL_CLASS} shrink-0 max-w-[9rem] truncate`} title={pageLabel}>
            {pageLabel}
          </span>
        )}
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
 * The rows the rail shows, in order.
 *
 * Every thread in the document, not just this page's: a thread left on another
 * page is still waiting for an answer, and each of these rows is a jump rather
 * than a look (the panel's `onFocusThread` switches page first). Open before
 * resolved, then newest first — the list is a queue of things to act on, not an
 * archive, and the page is deliberately not a grouping: the row names whichever
 * canvas it sits on.
 */
export function visibleThreads(threads: CommentThread[], filter: CommentFilter): CommentThread[] {
  const matches = (thread: CommentThread) =>
    filter === "all"
      ? true
      : filter === "resolved"
      ? thread.status === "resolved"
      : thread.status !== "resolved";
  return threads
    .filter(matches)
    .slice()
    .sort((a, b) => {
      const aDone = a.status === "resolved" ? 1 : 0;
      const bDone = b.status === "resolved" ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

/** Derived, not passed: one thread on another page is enough to need labels. */
export function spansPages(threads: CommentThread[]): boolean {
  return new Set(threads.map((thread) => thread.pageId)).size > 1;
}

/**
 * The comments rail: every thread in the document, in one list, with the canvas
 * as the other half of the same object.
 *
 * The list is NOT page-filtered. A thread someone left on page 2 is still a
 * thing waiting for an answer while you are looking at page 1, and hiding it
 * until you happen to open that page makes the rail a viewer of one canvas
 * rather than the queue it claims to be. Selecting such a row is a jump — it
 * switches page, brings the pin into view and opens the card (see the panel's
 * `onFocusThread`), which is why each row names its page once the threads span
 * more than one.
 *
 * It sits in the left rail rather than the right one because FISH's right rail
 * is the inspector, which is a fixed-width property stack for the selection —
 * comment threads are not properties of the selection and must survive changing
 * it.
 */
export function CommentsPanel({
  comments,
  pageId,
  pageNames,
  activeThreadId,
  onFocusThread,
  onResolve,
  onReopen,
  onDelete
}: CommentsPanelProps) {
  const [filter, setFilter] = useState<CommentFilter>("all");

  const visible = useMemo(() => visibleThreads(comments.threads, filter), [comments.threads, filter]);
  const multiPage = useMemo(() => spansPages(comments.threads), [comments.threads]);

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

      {/* 6px between rows, not the 2px a one-line layer row wants: these rows
          carry a title, two lines of message and a meta line, and the selected
          one fills `bg-selection` — closer than this and two cards read as one
          block. 6px plus the row's own 8px padding is the 12px a card is due. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5">
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
              pageLabel={
                multiPage
                  ? pageNames[thread.pageId] ?? thread.pageId
                  : undefined
              }
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

import { Eye, EyeOff, Sparkles } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { ACTION_BAR_TOGGLE_OFF, ACTION_BAR_TOGGLE_ON, ACTION_TOGGLE_ICON_CLASS } from "../inspector/action-bar-style";
import type { CommentDiffRow } from "../../core/comments/diff";

export interface CommentDiffCardProps {
  summary: string;
  rows: CommentDiffRow[];
  onApply: () => void;
  onDiscard: () => void;
  /** Applied/discarded stats still show the ops; the buttons only exist while pending. */
  pending?: boolean;
  /** An ops list that changes nothing has no result to look at. */
  canPreview?: boolean;
  previewOn?: boolean;
  onTogglePreview?: () => void;
  /**
   * Off when the summary is already the AI's last message — `fish comments
   * suggest` writes it as both, and the card repeating the sentence directly
   * under itself reads as two claims rather than one.
   */
  showSummary?: boolean;
}

/**
 * A row label is data, not prose: the core says `borderRadius`, this says the
 * word a person reads. A key with no dictionary entry falls back to itself
 * rather than to a `comments.field.…` path, so a new property a future op
 * introduces is still legible the day it lands.
 */
function fieldLabel(key: string): string {
  const path = `comments.field.${key}`;
  const label = t(path);
  return label === path ? key : label;
}

function DiffRow({ row }: { row: CommentDiffRow }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-2 py-0.5">
      <span className="text-meta text-ink-muted truncate">{fieldLabel(row.key)}</span>
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-code text-ink-muted line-through truncate max-w-[92px]">{row.before}</span>
        <span className="text-code text-ink-muted shrink-0">→</span>
        <span className="text-code text-ink truncate max-w-[92px]">{row.after}</span>
      </span>
    </div>
  );
}

/**
 * The review card for an AI suggestion: what it claims, what it actually changes,
 * and the two decisions the user owns.
 *
 * The rows are computed by applying the ops to a copy of the document
 * (`computeSuggestionDiff`), never by echoing the op payload — an agent's prose
 * summary is a claim, and the properties are the evidence.
 */
export function CommentDiffCard({
  summary,
  rows,
  onApply,
  onDiscard,
  pending = true,
  canPreview = true,
  previewOn = false,
  onTogglePreview,
  showSummary = true
}: CommentDiffCardProps) {
  return (
    <div
      data-ui-panel="comment-diff"
      className="flex flex-col gap-2 p-2 rounded-ctl bg-raised border border-rule"
    >
      <div className="flex items-center gap-1.5 text-brand text-row">
        <Sparkles size={12} />
        <span className="truncate">{t("comments.suggestedTitle")}</span>
      </div>

      {showSummary && summary && (
        <p className="text-ink text-ui leading-snug break-words">{summary}</p>
      )}

      {rows.length > 0 ? (
        <div className="flex flex-col border-t border-rule pt-1">
          {rows.map((row) => (
            <DiffRow key={row.key} row={row} />
          ))}
        </div>
      ) : (
        <p className="text-row text-ink-muted leading-snug">{t("comments.diffEmpty")}</p>
      )}

      {pending && (
        <div className="flex items-center justify-between gap-1.5 pt-0.5">
          {/* Looking at the result is not a third decision, so it sits apart from
              the two that are — same row, opposite end. */}
          <button
            type="button"
            data-comment-preview-toggle="true"
            disabled={!canPreview}
            onClick={onTogglePreview}
            aria-pressed={previewOn}
            title={t(previewOn ? "comments.previewHint" : canPreview ? "comments.preview" : "comments.previewUnavailable")}
            aria-label={t("comments.preview")}
            className={`${ACTION_TOGGLE_ICON_CLASS} ${
              previewOn ? ACTION_BAR_TOGGLE_ON : ACTION_BAR_TOGGLE_OFF
            } disabled:opacity-50`}
          >
            {previewOn ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          <div className="flex items-center gap-1.5">
            <Button size="field" variant="ghost" onClick={onDiscard}>
              {t("comments.discardSuggestion")}
            </Button>
            <Button size="field" variant="primary" onClick={onApply}>
              {t("comments.applySuggestion")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

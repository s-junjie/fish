import { useEffect, useRef } from "preact/hooks";
import { t } from "../../i18n";
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";
import { POPOVER_SURFACE_CLASS } from "../menu-style";

export interface CommentComposerProps {
  /** The layer (or "Canvas") the comment will be pinned to, already localised. */
  targetLabel: string;
  value: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * The "new comment" card: one field, two actions, Enter to commit.
 *
 * A reply is a different card (it has a thread above it), but this one is the
 * window a person actually writes in, so it wears the same title bar and the
 * same drag handle as an opened thread — two windows of the same kind cannot
 * have two headers.
 */
export function CommentComposer({ targetLabel, value, onInput, onSubmit, onCancel }: CommentComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // The card is portalled and starts hidden for one frame (it is placed after
    // measuring), so focusing on mount would be undone by that frame.
    const id = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const canSubmit = value.trim().length > 0;

  return (
    <div
      data-ui-panel="comment-composer"
      className={`${POPOVER_SURFACE_CLASS} px-2.5 pt-2 pb-2.5 flex flex-col gap-2 text-ui text-ink`}
      onClick={(e) => e.stopPropagation()}
    >
      <div data-comment-drag-handle="true" className="min-w-0 cursor-grab active:cursor-grabbing">
        <PanelHeader
          title={<span className="truncate">{targetLabel}</span>}
          titleClassName="min-w-0 truncate"
          onClose={onCancel}
          className="pb-1.5 border-b border-rule"
        />
      </div>
      <textarea
        ref={inputRef}
        rows={3}
        value={value}
        onInput={(e) => onInput((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
        placeholder={t("comments.placeholder")}
        aria-label={t("comments.placeholder")}
        className="w-full bg-field rounded-ctl p-1.5 text-ui text-ink border border-rule resize-none focus:outline-none focus:border-brand"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button size="field" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="field" variant="primary" disabled={!canSubmit} onClick={onSubmit}>
          {t("comments.send")}
        </Button>
      </div>
    </div>
  );
}

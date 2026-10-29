import { useEffect, useRef } from "preact/hooks";
import { ArrowUp } from "lucide-react";
import { t } from "../../i18n";
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

export function CommentComposer({ targetLabel, value, onInput, onSubmit, onCancel }: CommentComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
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
      if (value.trim()) onSubmit();
    }
  };

  const canSubmit = value.trim().length > 0;

  return (
    <div
      data-ui-panel="comment-composer"
      className={`${POPOVER_SURFACE_CLASS} px-2.5 pt-2 pb-2.5 flex flex-col gap-2 font-sans text-ui text-ink`}
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
      <div className="flex items-center gap-2 pt-0.5">
        <div className="w-6 h-6 rounded-full bg-raised border border-rule flex items-center justify-center text-row text-ink font-sans shrink-0">
          U
        </div>
        <div className="flex-1 min-w-0 relative flex items-center bg-field rounded-full border border-rule focus-within:border-brand transition-colors pl-3 pr-1 py-1">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            placeholder={t("comments.placeholder")}
            aria-label={t("comments.placeholder")}
            className="w-full bg-transparent text-ui text-ink border-0 p-0 focus:outline-none placeholder:text-ink-muted"
          />
          <button
            type="button"
            disabled={!canSubmit}
            onClick={onSubmit}
            aria-label={t("comments.send")}
            className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
              canSubmit
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

import { useState, useRef, useEffect } from "preact/hooks";
import { Loader2 } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { PanelHeader } from "../PanelHeader";
import { ROW_DENSE_CLASS } from "../row-style";

interface ImageUrlPopoverProps {
  title?: string;
  placeholder?: string;
  errorMessage?: string;
  /**
   * A code field rather than a URL: multi-line, wider, and Enter is a newline
   * rather than the commit. An embed snippet is one long tag and a single-line
   * input folds it past the point where its own `src` can be read back.
   */
  multiline?: boolean;
  onSubmit: (value: string, signal?: AbortSignal) => Promise<void> | void;
  onClose: () => void;
}

export function ImageUrlPopover({
  title,
  placeholder,
  errorMessage,
  multiline = false,
  onSubmit,
  onClose
}: ImageUrlPopoverProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fieldRef.current?.focus();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleCancel = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setSubmitting(false);
    onClose();
  };

  const handleSubmit = async () => {
    const clean = value.trim();
    if (!clean || submitting) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(clean, controller.signal);
      if (!controller.signal.aborted) {
        setValue("");
        onClose();
      }
    } catch (err: any) {
      if (!controller.signal.aborted && err?.name !== "AbortError") {
        setError(errorMessage || t("toolbar.imageUrlError"));
      }
    } finally {
      if (abortControllerRef.current === controller) {
        setSubmitting(false);
        abortControllerRef.current = null;
      }
    }
  };

  const dialogTitle = title || t("toolbar.insertImageUrl");
  const inputPlaceholder = placeholder || t("toolbar.imageUrlPlaceholder");

  const fieldClass = `w-full px-2 rounded-ctl border border-rule bg-inset text-ink placeholder:text-ink-muted focus:outline-none focus:border-brand disabled:opacity-50 mb-2 ${
    multiline ? "h-[62px] py-1.5 text-code resize-none" : "h-[24px] text-ui"
  }`;

  const onFieldKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
    // In a code field Enter belongs to the text; the commit takes the modifier.
    const commit = multiline ? (e.metaKey || e.ctrlKey) && e.key === "Enter" : e.key === "Enter";
    if (commit) {
      e.preventDefault();
      void handleSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  const onFieldInput = (e: Event) => {
    setValue((e.target as HTMLInputElement | HTMLTextAreaElement).value);
    if (error) setError(null);
  };

  // One holder for two element types: the field is an input or a textarea and
  // only one of them exists per render, so a typed ref would have to lie.
  const attachField = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    fieldRef.current = el;
  };

  return (
    <div
      role="dialog"
      aria-label={dialogTitle}
      className={`absolute bottom-11 left-0 z-50 rounded-pill border border-rule-strong bg-surface p-2.5 shadow-popover ${
        multiline ? "w-[320px]" : "min-w-[260px]"
      }`}
    >
      <PanelHeader title={dialogTitle} className="mb-1.5 px-0.5" />
      {multiline ? (
        <textarea
          ref={attachField}
          name="image-url"
          value={value}
          rows={3}
          spellcheck={false}
          disabled={submitting}
          onInput={onFieldInput}
          placeholder={inputPlaceholder}
          className={fieldClass}
          onKeyDown={onFieldKeyDown}
        />
      ) : (
        <input
          ref={attachField}
          type="url"
          name="image-url"
          value={value}
          disabled={submitting}
          onInput={onFieldInput}
          placeholder={inputPlaceholder}
          className={fieldClass}
          onKeyDown={onFieldKeyDown}
        />
      )}
      {error && <div className="text-row text-measure-coral mb-2 px-0.5">{error}</div>}
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="text" onClick={handleCancel}>
          {t("toolbar.cancel")}
        </Button>
        <Button
          variant="primary"
          size="text"
          disabled={!value.trim() || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? (
            <div className={ROW_DENSE_CLASS}>
              <Loader2 size={11} className="animate-spin" />
              <span>{t("toolbar.insert")}</span>
            </div>
          ) : (
            t("toolbar.insert")
          )}
        </Button>
      </div>
    </div>
  );
}

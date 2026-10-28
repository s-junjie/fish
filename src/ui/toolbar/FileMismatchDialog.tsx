import { useState, useEffect, useCallback } from "preact/hooks";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import { AlertTriangle, Copy, Check } from "lucide-react";
import { t } from "../../i18n";

interface FileMismatchDialogProps {
  reason: string;
  openedName: string | null;
  filePath?: string;
  fileDirectory?: string;
  onDismiss: () => void;
  onRetry: () => void;
}

export function FileMismatchDialog({
  reason,
  openedName,
  filePath,
  fileDirectory,
  onDismiss,
  onRetry
}: FileMismatchDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onDismiss();
    }
  };
  useWindowKeydown(handleKeyDown, [onDismiss]);

  const handleCopyPath = useCallback(() => {
    const target = fileDirectory || filePath;
    if (!target) return;
    void navigator.clipboard.writeText(target).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [fileDirectory, filePath]);

  const errorText =
    reason === "not-a-fish-file"
      ? t("autosave.pickNotFish")
      : reason === "cannot-read"
      ? t("autosave.pickCannotRead")
      : reason === "restored-mismatch"
      ? t("autosave.restoredMismatch")
      : t("autosave.pickMismatch");

  const pathToShow = fileDirectory || filePath;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="bg-panel border border-rule rounded-panel shadow-modal p-5 max-w-sm w-full flex flex-col gap-3.5 text-ink animate-pop-in">
        <div className="flex items-center gap-2 text-brand text-displaySm">
          <AlertTriangle size={18} className="shrink-0" />
          <span>{t("autosave.error")}</span>
        </div>

        <p className="text-ui text-ink-dim leading-relaxed">{errorText}</p>

        {(openedName || pathToShow) && (
          <div className="bg-inset border border-rule rounded-ctl p-2.5 flex flex-col gap-2 text-ui ">
            {openedName && (
              <div className="truncate">
                <span className="text-ink-muted mr-1.5">{t("autosave.openedFile")}:</span>
                <span className="text-ink font-semibold">{openedName}</span>
              </div>
            )}
            {pathToShow && (
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-rule/40">
                <div className="truncate text-ink-muted text-ui flex-1" title={pathToShow}>
                  <span className="text-ink-dim mr-1">{t("autosave.folderLabel")}:</span>
                  {pathToShow}
                </div>
                <button
                  onClick={handleCopyPath}
                  className="shrink-0 flex items-center gap-1 text-ui text-ink-dim hover:text-ink px-1.5 py-0.5 rounded-ctl border border-rule hover:border-brand transition-colors"
                  title={t("autosave.copyPath")}
                >
                  {copied ? <Check size={10} className="text-brand" /> : <Copy size={10} />}
                  <span>{copied ? t("autosave.pathCopied") : t("autosave.copyPath")}</span>
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1 font-sans">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 rounded-ctl text-ui text-ink-dim hover:text-ink border border-rule hover:border-brand transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={onRetry}
            className="px-3 py-1.5 rounded-ctl text-ui bg-brand hover:opacity-90 text-brand-ink font-medium transition-opacity"
          >
            {t("autosave.pickRetry")}
          </button>
        </div>
      </div>
    </div>
  );
}

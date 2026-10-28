import { useEffect } from "preact/hooks";
import { Loader2 } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";
import { setPickerOpen } from "../hooks/picker-focus";
import { useWindowKeydown } from "../hooks/useWindowKeydown";

export interface ImportProgressDialogProps {
  name: string;
  stage: "mount" | "assets" | "measure" | "build";
  percent?: number;
  onCancel: () => void;
}

export function ImportProgressDialog({
  name,
  stage,
  percent = 25,
  onCancel
}: ImportProgressDialogProps) {
  useEffect(() => {
    setPickerOpen(true);
    return () => setPickerOpen(false);
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  useWindowKeydown(handleKeyDown, [onCancel]);

  const stageText =
    stage === "mount"
      ? t("htmlImport.stageMount")
      : stage === "assets"
      ? t("htmlImport.stageAssets")
      : stage === "measure"
      ? t("htmlImport.stageMeasure")
      : t("htmlImport.stageBuild");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("htmlImport.progressTitle")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        data-html-import-progress="true"
        className="bg-panel border border-rule rounded-panel shadow-modal p-5 w-full max-w-sm flex flex-col gap-3.5 text-ink animate-pop-in"
      >
        <div className="flex items-center gap-2 text-brand text-displaySm">
          <Loader2 size={18} className="animate-spin shrink-0 text-brand" />
          <span>{t("htmlImport.progressTitle")}</span>
        </div>

        <div className="bg-inset border border-rule rounded-ctl px-2.5 py-2 flex items-baseline gap-2 text-ui min-w-0">
          <span className={SUB_LABEL_CLASS}>{t("htmlImport.target")}</span>
          <span className="truncate text-ink font-medium" title={name}>
            {name}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-row text-ink-dim">
            <span>{stageText}</span>
            <span className="font-mono text-ink-muted">{Math.round(percent)}%</span>
          </div>

          <div className="bg-inset border border-rule rounded-full h-1.5 overflow-hidden w-full">
            <div
              className="bg-brand h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.max(5, Math.min(100, percent))}%` }}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1 font-sans">
          <Button
            type="button"
            variant="ghost"
            size="field"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}

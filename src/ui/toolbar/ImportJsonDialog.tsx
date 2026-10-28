import { useEffect, useMemo, useRef } from "preact/hooks";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import { FileJson, AlertTriangle, Check, Layers, Replace as ReplaceIcon } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { SUB_LABEL_CLASS } from "../label-tier";
import { setPickerOpen } from "../hooks/picker-focus";
import { isContainer } from "../../core/geometry/tree-ops";
import type { DesignElement } from "../../core/dsl/types";
import type { PickedJson } from "../../core/persistence/json-file";

interface ImportJsonDialogProps {
  picked: PickedJson;
  /** The file auto-save would rewrite if the user replaces in place. */
  writebackTarget: string | null;
  onDismiss: () => void;
  onReplace: () => void;
  onMerge: () => void;
}

/**
 * The one question a `.fish.json` file forces: replace what is here, or sit
 * beside it.
 *
 * A modal rather than a menu with two rows because the two answers are not
 * siblings — one is additive, the other discards the document this tab has been
 * auto-saving to disk. Naming the file that would be overwritten is the whole
 * reason this is a dialog rather than a second step inside the one that picked
 * the file: the consequence is only knowable once the file has been read, and by
 * then the picker is gone.
 *
 * Merge takes the initial focus because it is the one that destroys nothing, and
 * undo is not the answer to a file the wrong door already overwrote.
 */
export function ImportJsonDialog({
  picked,
  writebackTarget,
  onDismiss,
  onReplace,
  onMerge
}: ImportJsonDialogProps) {
  const mergeRef = useRef<HTMLButtonElement>(null);

  // A modal is a keyboard surface: without this the Escape that closes it would
  // also reach `useShortcuts` and act on the canvas behind it.
  useEffect(() => {
    setPickerOpen(true);
    mergeRef.current?.focus();
    return () => setPickerOpen(false);
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
    if (e.key === "Escape") onDismiss();
  };
  useWindowKeydown(handleKeyDown, [onDismiss]);

  const summary = useMemo(() => {
    const pages = picked.doc.pages ?? [];
    return {
      pages: pages.length,
      elements: pages.reduce((n, p) => n + countIn(p.children), 0)
    };
  }, [picked]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("documentJson.importTitle")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        data-import-from-json="true"
        className="bg-panel border border-rule rounded-panel shadow-modal p-5 w-full max-w-md flex flex-col gap-3.5 text-ink animate-pop-in"
      >
        <div className="flex items-center gap-2 text-brand text-displaySm">
          <FileJson size={18} className="shrink-0" />
          <span>{t("documentJson.importTitle")}</span>
        </div>

        <div className="bg-inset border border-rule rounded-ctl px-2.5 py-2 flex items-baseline gap-2 text-ui min-w-0">
          <span className={SUB_LABEL_CLASS}>{t("documentJson.importIncoming")}</span>
          <span className="truncate text-ink" title={picked.fileName}>
            {picked.fileName}
          </span>
        </div>

        <div data-import-from-json-status="true">
          <ParsedStatus summary={summary} repairs={picked.repairs.length} />
        </div>

        <p className="text-ui text-ink-muted leading-relaxed">{t("documentJson.importQuestion")}</p>

        <div className="flex flex-col gap-2">
          <button
            ref={mergeRef}
            type="button"
            data-import-merge="true"
            onClick={onMerge}
            className="text-left bg-raised border border-rule-strong rounded-ctl px-3 py-2.5 flex flex-col gap-1 hover:border-brand transition-colors"
          >
            <span className="flex items-center gap-2 text-ui text-ink">
              <Layers size={14} className="shrink-0" />
              {t("documentJson.importMergeAction")}
            </span>
            <span className="text-row text-ink-muted leading-relaxed">
              {t("documentJson.importMergeHint", { pages: summary.pages })}
            </span>
          </button>

          <button
            type="button"
            data-import-replace="true"
            onClick={onReplace}
            className="text-left bg-raised border border-rule-strong rounded-ctl px-3 py-2.5 flex flex-col gap-1 hover:border-measure-coral transition-colors"
          >
            <span className="flex items-center gap-2 text-ui text-ink">
              <ReplaceIcon size={14} className="shrink-0" />
              {t("documentJson.importReplaceAction")}
            </span>
            <span className="text-row text-ink-muted leading-relaxed">{t("documentJson.importReplaceHint")}</span>
            {/* Inside the card, not below it: the file auto-save is about to
                rewrite belongs to THIS choice, and a detached warning box under
                two cards reads as a note about both of them. */}
            {writebackTarget && (
              <span className="flex items-start gap-1.5 text-row text-measure-coral leading-relaxed pt-0.5">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                {t("documentJson.replaceOverwriteWarning", { file: writebackTarget })}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1 font-sans">
          <Button variant="ghost" size="field" onClick={onDismiss}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function countIn(els: readonly DesignElement[] | undefined): number {
  return (els ?? []).reduce((n, el) => n + 1 + (isContainer(el) ? countIn(el.children) : 0), 0);
}

function ParsedStatus({ summary, repairs }: { summary: { pages: number; elements: number }; repairs: number }) {
  return (
    <div className="flex items-center gap-2 text-row text-ink-dim">
      <Check size={12} className="text-brand shrink-0" />
      <span>{t("documentJson.importSummary", { pages: summary.pages, elements: summary.elements })}</span>
      {repairs > 0 && <span className="text-ink-muted">{t("documentJson.replaceRepairs", { count: repairs })}</span>}
    </div>
  );
}
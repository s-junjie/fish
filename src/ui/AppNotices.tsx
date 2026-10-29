import { History, AlertTriangle, X, Loader2, ImageOff } from "lucide-react";
import { useRef } from "preact/hooks";
import { t } from "../i18n";
import type { DesignDocument } from "../core/dsl/types";
import type { AutosaveController } from "../core/persistence/autosave-controller";
import type { PendingAssets } from "./hooks/useHtmlImport";
import { Button } from "./Button";
import { TITLE_BAR_HEIGHT } from "./toolbar/titlebar-layout";
import { ROW_CLASS, ROW_TIGHT_CLASS } from "./row-style";

interface AppNoticesProps {
  pendingRecovery: DesignDocument | null;
  /**
   * Applies the pending snapshot. Comments live beside the document, so the
   * caller that owns both has to own this; absent, the document alone is
   * committed, which is what this did before comments existed.
   */
  onRecover?: () => void;
  openedName: string | null;
  loadFailed: boolean;
  hintMessage?: string;
  /** Takes the toast down by hand; absent leaves the timer the only way down. */
  onHintDismiss?: () => void;
  /**
   * Pinned work-in-progress line (e.g. "copy as PNG" rasterizing). No timer:
   * it goes down when the work settles, so it is a separate slot from the
   * toast rather than a hint that would be timed off its own text length.
   */
  busyMessage?: string | null;
  /** The panel being open IS history mode: this notice would be in its way. */
  historyOpen: boolean;
  /** Bitmaps an import could not read; the notice offers the folder that holds them. */
  pendingAssets?: PendingAssets | null;
  onAttachAssetFolder?: (files: FileList) => void;
  onDismissAssetFolder?: () => void;
  commitSnapshot: (doc: DesignDocument) => void;
  setPendingRecovery: (doc: DesignDocument | null) => void;
  controllerRef: { current: AutosaveController | null };
}

/**
 * Top-center critical recovery notices and transient toast hints.
 * Stacked cleanly in a single flex container to avoid overlap.
 */
export function AppNotices(props: AppNoticesProps) {
  const {
    pendingRecovery,
    onRecover,
    openedName,
    loadFailed,
    hintMessage,
    onHintDismiss,
    busyMessage,
    historyOpen,
    pendingAssets,
    onAttachAssetFolder,
    onDismissAssetFolder,
    commitSnapshot,
    setPendingRecovery,
    controllerRef
  } = props;
  const folderInputRef = useRef<HTMLInputElement>(null);

  if (
    (!pendingRecovery || historyOpen) &&
    !loadFailed &&
    !hintMessage &&
    !busyMessage &&
    !pendingAssets
  ) {
    return null;
  }

  return (
    <div
      style={{ top: TITLE_BAR_HEIGHT + 12 }}
      className="fixed left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2 pointer-events-none"
    >
      {/* Recovered edits: offered, never applied behind the user's back. The
          file stays the source of truth, so the alternative to recovering is
          simply to keep what was loaded. Held back while history mode is open:
          `Recover` writes a snapshot the open panel would refuse anyway, so the
          notice would be a button that does nothing. */}
      {pendingRecovery && !historyOpen && (
        <div className="pointer-events-auto font-sans bg-surface border border-rule-strong text-ink text-ui px-3 py-1.5 rounded-dock flex items-center gap-3">
          <div className={ROW_CLASS}>
            <History size={14} className="text-brand flex-none" />
            <span>{t("autosave.recoveryFound")}</span>
          </div>
          <div className={ROW_TIGHT_CLASS}>
            <Button
              variant="primary"
              size="text"
              onClick={() => {
                if (onRecover) onRecover();
                else commitSnapshot(pendingRecovery);
                setPendingRecovery(null);
              }}
            >
              {t("autosave.recoveryRestore")}
            </Button>
            <Button
              variant="ghost"
              size="text"
              onClick={() => {
                void controllerRef.current?.discardRecovery();
                setPendingRecovery(null);
              }}
            >
              {t("autosave.recoveryDiscard")}
            </Button>
          </div>
        </div>
      )}

      {/* The file's document block would not parse and no local copy exists.
          Shown rather than swallowed: a blank canvas with no explanation is
          indistinguishable from "my work is gone". */}
      {loadFailed && (
        <div className="pointer-events-auto font-sans bg-surface border border-rule-strong text-ink text-ui px-4 py-3 rounded-panel flex items-center gap-3">
          <AlertTriangle size={16} className="text-measure-coral flex-none" />
          <div>
            <div>{t("autosave.loadCorrupt")}</div>
            {openedName && <div className="text-ui text-ink-dim mt-0.5">{openedName}</div>}
          </div>
        </div>
      )}

      {/* A page opened from disk names its bitmaps by relative path, and a file
          picker hands over text rather than a location — so the pictures are
          missing while their boxes are not. The folder that holds them is one
          click away, and offering it here is the difference between "the import
          dropped my photo" and "point me at the folder". */}
      {pendingAssets && (
        <div
          data-asset-notice="true"
          className="pointer-events-auto font-sans bg-surface border border-rule-strong text-ink text-ui px-3 py-1.5 rounded-dock flex items-center gap-3 animate-pop-in"
        >
          <ImageOff size={14} className="text-brand flex-none" />
          <div>
            <div>
              {t("htmlImport.assetsNotice", { k: pendingAssets.elements, n: pendingAssets.missing.length })}
            </div>
            <div className="text-ui text-ink-dim mt-0.5">{t("htmlImport.assetsNoticeWhy")}</div>
          </div>
          <div className={ROW_TIGHT_CLASS}>
            <Button variant="primary" size="text" onClick={() => folderInputRef.current?.click()}>
              {t("htmlImport.assetsPick")}
            </Button>
            <Button variant="ghost" size="text" onClick={onDismissAssetFolder}>
              {t("common.close")}
            </Button>
          </div>
          <input
            // `webkitdirectory` is a boolean PROPERTY on the input, and a JSX
            // prop is assigned as one — `""` coerces to false, so the picker
            // stayed a file picker. It is set as an ATTRIBUTE instead, which is
            // the only form the directory mode is read from.
            ref={(el: HTMLInputElement | null) => {
              folderInputRef.current = el;
              el?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            name="asset-directory"
            multiple
            className="hidden"
            onChange={(event) => {
              const input = event.currentTarget as HTMLInputElement;
              if (input.files && input.files.length > 0) onAttachAssetFolder?.(input.files);
              // Re-picking the same folder has to fire again.
              input.value = "";
            }}
          />
        </div>
      )}



      {/* Ephemeral toast / hint message (e.g. UI hidden notice, component messages) */}
      {hintMessage && (
        <div
          data-hint="true"
          className="pointer-events-auto font-sans bg-surface border border-rule-strong text-ink text-ui px-4 py-2 rounded-dock flex items-center gap-2 animate-pop-in"
        >
          {hintMessage}
          {/* Read it and want it gone: the timer is the fallback, not the only
              way down. An import report is the hint most likely to be dismissed
              by hand — it is the one worth reading twice. */}
          {onHintDismiss && (
            <button
              type="button"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={onHintDismiss}
              className="flex-none -mr-1 p-0.5 rounded-ctl text-ink-dim hover:text-ink hover:bg-raised"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {/* Pinned in-progress line: the spinner IS the message, so nothing is
          dismissable — it ends when the work does. Sits below the toast slot
          so a completed report can appear while it is still up and replace it
          without overlap. */}
      {busyMessage && (
        <div
          data-busy="true"
          className="pointer-events-auto font-sans bg-surface border border-rule-strong text-ink text-ui px-4 py-2 rounded-dock flex items-center gap-2 animate-pop-in"
        >
          <Loader2 size={14} className="animate-spin flex-none text-brand" />
          <span>{busyMessage}</span>
        </div>
      )}
    </div>
  );
}

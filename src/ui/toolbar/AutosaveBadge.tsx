import { useState, useRef, useEffect, useCallback } from "preact/hooks";
import { ChevronDown, Check, Copy, Save, History, FileDown, FilePlus, FileUp, FileInput, AlertTriangle, ShieldCheck, RotateCcw } from "lucide-react";
import { t } from "../../i18n";
import type { AutosaveStatus } from "../../core/persistence/autosave-controller";
import { Button } from "../Button";
import { MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS, MENU_SHORTCUT_CLASS, POPOVER_SURFACE_CLASS } from "../menu-style";
import { ROW_CLASS } from "../row-style";

interface AutosaveBadgeProps {
  autosaveStatus: AutosaveStatus | null;
  showActivateAutosave: boolean;
  writebackTarget: string | null;
  openedName: string | null;
  filePath?: string;
  fileDirectory?: string;
  /** Set when a save-as moved this tab onto a file the URL cannot name. */
  savedAsCopyOf?: string | null;
  otherTabActive: boolean;
  onActivateAutosave: () => void | Promise<unknown>;
  onSave: () => void | Promise<unknown>;
  onSaveAs: () => void | Promise<unknown>;
  onNewFile: () => void;
  onOpenHistory: () => void;
  onExportJson: () => Promise<boolean>;
  onImportJson: () => void | Promise<unknown>;
  onImportFromFile: (file: File) => void;
  /** False without `showOpenFilePicker`, where the row opens a file input instead. */
  canUseFilePicker: boolean;
}

const WRITE_REASON_KEYS: Record<string, string> = {
  "no-file": "autosave.reasonNoFile",
  "no-handle": "autosave.reasonNoFile",
  "cannot-read": "autosave.reasonCannotRead",
  "not-a-fish-file": "autosave.reasonNotFish",
  "content-mismatch": "autosave.reasonMismatch",
  "name-mismatch": "autosave.reasonMismatch",
  "no-writable": "autosave.reasonWriteFailed",
  "write-failed": "autosave.reasonWriteFailed",
  "no-save-picker": "autosave.reasonUnsupported",
  "no-open-picker": "autosave.reasonUnsupported"
};

/**
 * `writeBackFile` classifies what it can as `permission:<state>` and
 * `backup-unavailable:<error>` and passes a raw DOMException message through
 * otherwise. Only the prefix is worth translating; the tail is diagnostic and
 * stays verbatim so a bug report still carries it.
 */
function describeUnavailableReason(reason: string): string {
  const known = WRITE_REASON_KEYS[reason];
  if (known) return t(known);
  const [prefix, detail] = reason.split(/:(.*)/);
  if (!detail) return reason;
  if (prefix === "permission") return t("autosave.reasonPermission", { state: detail });
  if (prefix === "backup-unavailable") return t("autosave.reasonBackup", { detail });
  return reason;
}

function splitPathForDisplay(path: string): { prefix: string; suffix: string } {
  if (!path) return { prefix: "", suffix: "" };
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep);
  if (parts.length > 2) {
    const splitIndex = parts.length > 3 ? parts.length - 2 : parts.length - 1;
    const prefix = parts.slice(0, splitIndex).join(sep);
    const suffix = `${sep}${parts.slice(splitIndex).join(sep)}`;
    return { prefix, suffix };
  }
  return { prefix: path, suffix: "" };
}

export function AutosaveBadge(props: AutosaveBadgeProps) {
  const {
    autosaveStatus,
    showActivateAutosave,
    writebackTarget,
    openedName,
    filePath,
    fileDirectory,
    savedAsCopyOf,
    otherTabActive,
    onActivateAutosave,
    onSave,
    onSaveAs,
    onNewFile,
    onOpenHistory,
    onExportJson,
    onImportJson,
    onImportFromFile,
    canUseFilePicker
  } = props;

  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close popover when clicking outside or pressing Escape
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleCopyPath = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    const target = fileDirectory || filePath;
    if (!target) return;
    void navigator.clipboard.writeText(target).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [fileDirectory, filePath]);

  /**
   * Run a row's action, and close the popover only once it has settled.
   *
   * The close cannot be timed. The native dialog is built in the browser
   * process a frame or two after the call returns, so *any* delay — a `0ms`
   * timer included — can still unmount the button that owns focus while macOS
   * is assembling the panel, and an `NSOpenPanel` without a key window comes up
   * with every file greyed out. That is the intermittent first-open failure;
   * the second attempt works because by then the window is key again. Waiting
   * for the action's promise keeps the row mounted for as long as the dialog
   * exists.
   */
  const closeAfter = (action: () => void | Promise<unknown>) => {
    const pending = action();
    void Promise.resolve(pending).finally(() => setIsOpen(false));
  };

  const handleExportJson = useCallback(() => {
    closeAfter(() =>
      onExportJson().then((ok) => {
        if (!ok) return;
        setExported(true);
        setTimeout(() => setExported(false), 2000);
      })
    );
  }, [onExportJson]);

  const handleImportJson = useCallback(() => {
    closeAfter(() => {
      if (canUseFilePicker) return onImportJson();
      fileInputRef.current?.click();
    });
  }, [canUseFilePicker, onImportJson]);

  // Derive visual state
  const isConflict = otherTabActive;
  const isSaving = autosaveStatus?.kind === "file-writing" || autosaveStatus?.kind === "local-saving";
  const isFileSaved = autosaveStatus?.kind === "file-saved";
  const isLocalSaved = autosaveStatus?.kind === "local-saved";
  const errorStatus = autosaveStatus?.kind === "error" ? autosaveStatus : null;
  const unavailableStatus = autosaveStatus?.kind === "file-unavailable" ? autosaveStatus : null;
  // A failed write and a failed local snapshot are not the same ask: re-granting
  // a handle fixes the first and does nothing for the second, so only the first
  // offers the button. Collapsing both into "off" is what made a dead handle
  // read as "you never turned auto-save on".
  const needsGrant = showActivateAutosave || unavailableStatus !== null;
  const isOff =
    needsGrant || (!isFileSaved && !isSaving && !isLocalSaved && errorStatus === null);
  const isGranted = !needsGrant && !isOff;

  const activeDocName = writebackTarget || openedName;
  // "Select this file" only helps if it says which file. The picker is an *open*
  // picker — it grants a handle to a file that already exists, and the one
  // auto-save needs is the tab's own — so name it when the tab was opened from a
  // file, and describe it when it was not.
  const grantTarget = activeDocName ?? t("autosave.fileInThisTab");
  const offDescription = canUseFilePicker
    ? t("autosave.popoverDescOff", { file: grantTarget })
    : t("autosave.reasonUnsupported");

  let labelText = t("autosave.statusOff");
  let descText = offDescription;
  let dotColor = "bg-ink-muted";
  let statusKind = autosaveStatus?.kind ?? (showActivateAutosave ? "inactive" : undefined);

  if (isConflict) {
    labelText = t("autosave.statusPaused");
    descText = t("autosave.popoverDescPaused");
    dotColor = "bg-measure-coral";
    statusKind = "error";
  } else if (isSaving) {
    labelText = t("app.saving");
    // Write-back is already armed here, so describing it as "off" would tell the
    // user to redo an action they do not need to redo.
    descText = isOff ? offDescription : t("autosave.popoverDescOn");
    // Neutral, not brand. `brand` means "armed tool" or "commit"; a save in
    // flight is neither, and painting it amber made the title bar's least
    // important state the loudest thing in it. The pulse still carries "working".
    dotColor = "bg-ink-dim animate-pulse-soft";
  } else if (errorStatus) {
    labelText = t("autosave.statusError");
    descText = t("autosave.popoverDescError", { message: errorStatus.message });
    dotColor = "bg-measure-coral";
    statusKind = "error";
  } else if (unavailableStatus) {
    labelText = t("autosave.statusUnavailable");
    descText = t("autosave.popoverDescUnavailable", {
      reason: describeUnavailableReason(unavailableStatus.reason)
    });
    dotColor = "bg-measure-coral";
    statusKind = "unavailable";
  } else if (isFileSaved) {
    labelText = t("autosave.statusOn");
    descText = t("autosave.popoverDescOn");
    dotColor = "bg-ink-dim";
  } else if (isLocalSaved) {
    labelText = t("autosave.statusLocal");
    // The Grant Access button sits directly under this line, so the line has to
    // name that action — otherwise the two read as unrelated controls.
    descText = isOff ? offDescription : t("autosave.popoverDescLocal");
    dotColor = "bg-ink-dim";
  }

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        data-autosave-status="true"
        /* Saving finishing is an event, not a decoration: a screen reader has no
           other way to learn the write landed. `assertive` only for the states
           that need to interrupt — another tab holding the file, and a save that
           did not land. */
        aria-live={isConflict || errorStatus ? "assertive" : "polite"}
        data-autosave-kind={statusKind}
        className="font-sans flex items-center gap-1.5 px-2 py-0.5 rounded-ctl text-row text-ink-dim hover:text-ink hover:bg-raised transition-colors duration-micro ease-snap"
        title={labelText}
        aria-expanded={isOpen}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="truncate max-w-[160px]">{labelText}</span>
        <ChevronDown size={11} className="text-ink-muted" />
      </button>

      {isOpen && (
        <div
          data-autosave-popover="true"
          className={`absolute left-1/2 -ml-36 top-full mt-1.5 w-72 origin-top ${POPOVER_SURFACE_CLASS} font-sans px-3 py-3.5 text-ui text-ink flex flex-col gap-3 animate-pop-in`}
        >
          {/* Status Header */}
          <div className="flex items-start gap-2.5">
            {isConflict || errorStatus || unavailableStatus ? (
              <AlertTriangle size={15} className="text-measure-coral shrink-0 mt-0.5" />
            ) : isFileSaved ? (
              <ShieldCheck size={15} className="text-ink-dim shrink-0 mt-0.5" />
            ) : (
              <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${dotColor}`} />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-displaySm font-semibold text-ink leading-tight">
                {isConflict
                  ? t("autosave.statusPaused")
                  : errorStatus
                  ? t("autosave.statusError")
                  : unavailableStatus
                  ? t("autosave.statusUnavailable")
                  : isFileSaved
                  ? t("autosave.statusOn")
                  : isLocalSaved
                  ? t("autosave.statusLocal")
                  : t("autosave.statusOff")}
              </div>
              <p className="text-row text-ink-dim leading-normal">{descText}</p>
            </div>
          </div>

          {/* File & Folder Details */}
          {(activeDocName || fileDirectory) && (
            <div className="bg-raised border border-rule-strong rounded-ctl p-2 flex flex-col gap-1.5 text-ui">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="truncate text-ink font-medium text-row min-w-0" title={activeDocName ?? undefined}>
                  {activeDocName || t("autosave.fileInThisTab")}
                </span>
                {(fileDirectory || filePath) && (
                  <button
                    onClick={handleCopyPath}
                    className="shrink-0 flex items-center gap-1 h-[22px] text-row text-ink-dim hover:text-ink px-2 rounded-ctl border border-rule hover:border-rule-strong hover:bg-field transition-colors"
                    title={t("autosave.copyPath")}
                  >
                    {copied ? <Check size={10} className="text-brand" /> : <Copy size={10} />}
                    <span>{copied ? t("autosave.pathCopied") : t("autosave.copyPath")}</span>
                  </button>
                )}
              </div>
              {savedAsCopyOf ? (
                /* The tab writes to a file the address bar cannot name: the URL
                   still opens the original, and its folder is not this target's.
                   Say which file the URL belongs to instead of showing a path
                   that describes neither the tab nor what auto-save writes. */
                <div
                  data-autosave-copy-note="true"
                  className="pt-1 border-t border-rule text-ink-muted text-row leading-relaxed"
                >
                  {t("autosave.savedAsCopy", { original: savedAsCopyOf })}
                </div>
              ) : (
                fileDirectory &&
                (() => {
                  const { prefix, suffix } = splitPathForDisplay(fileDirectory);
                  return (
                    <div
                      className="pt-1 border-t border-rule text-ink-muted text-row flex items-center min-w-0 overflow-hidden"
                      title={fileDirectory}
                    >
                      <span className="text-ink-dim mr-1 shrink-0">{t("autosave.folderLabel")}:</span>
                      <span className="truncate min-w-0">{prefix}</span>
                      {suffix ? <span className="shrink-0 max-w-[65%] truncate">{suffix}</span> : null}
                    </div>
                  );
                })()
              )}
            </div>
          )}

          {/* Activation Action Button when Off */}
          {isOff && canUseFilePicker && (
            <Button
              variant="primary"
              size="field"
              block
              onClick={() => closeAfter(onActivateAutosave)}
            >
              <span className="text-brand-ink font-medium">{t("autosave.activate")}</span>
            </Button>
          )}

          {/* Operations Menu */}
          <div className="border-t border-rule pt-2 flex flex-col gap-0.5 -mx-1">
            {isGranted && (
              <button
                onClick={() => closeAfter(onSave)}
                data-title-bar-save="true"
                className={`${MENU_ITEM_CLASS} justify-between`}
              >
                <div className={ROW_CLASS}>
                  <Save size={13} />
                  <span>{t("app.save")}</span>
                </div>
                <span className={MENU_SHORTCUT_CLASS}>⌘S</span>
              </button>
            )}

            <button
              onClick={() => closeAfter(onSaveAs)}
              data-title-bar-save-as="true"
              className={`${MENU_ITEM_CLASS} justify-between`}
            >
              <div className={ROW_CLASS}>
                <FileDown size={13} />
                <span>{t("app.saveAs")}</span>
              </div>
              <span className={MENU_SHORTCUT_CLASS}>⇧⌘S</span>
            </button>

            <div className={MENU_SEPARATOR_CLASS} />

            {/* One section: the two ways a document leaves or enters this tab.
                They are a set because they are the transport, not the file — what
                they share is that none of them is "save", so grouping them apart
                from Save / Save As is what keeps the destructive rows honest. */}
            <button onClick={handleExportJson} data-title-bar-export-json="true" className={`${MENU_ITEM_CLASS} justify-between`}>
              <div className={ROW_CLASS}>
                {exported ? <Check size={13} className="text-brand" /> : <FileUp size={13} />}
                <span>{t("documentJson.exportAction")}</span>
              </div>
            </button>

            <button onClick={handleImportJson} data-title-bar-import-json="true" className={`${MENU_ITEM_CLASS} justify-between`}>
              <div className={ROW_CLASS}>
                <FileInput size={13} />
                <span>{t("documentJson.importAction")}</span>
              </div>
            </button>

            <div className={MENU_SEPARATOR_CLASS} />

            <button
              onClick={() => {
                setIsOpen(false);
                onNewFile();
              }}
              data-title-bar-new-file="true"
              className={`${MENU_ITEM_CLASS} justify-between`}
            >
              <div className={ROW_CLASS}>
                <RotateCcw size={13} />
                <span>{t("autosave.startFromScratch")}</span>
              </div>
            </button>

            <div className={MENU_SEPARATOR_CLASS} />

            {/* Last, alone. It is the only row that puts the document into a
                read-only mode and fills the right edge of the screen, so it reads
                as leaving the editor rather than as one more file operation. */}
            <button
              onClick={() => {
                setIsOpen(false);
                onOpenHistory();
              }}
              data-title-bar-history="true"
              className={`${MENU_ITEM_CLASS} justify-between`}
            >
              <div className={ROW_CLASS}>
                <History size={13} />
                <span>{t("history.title")}</span>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Outside the popover on purpose: this input owns the native dialog it
          opens, and unmounting it with the menu would close that dialog's owner
          mid-flight — the same no-key-window state that greys the list out. */}
      <input
        ref={fileInputRef}
        type="file"
        name="document-file"
        accept=".json"
        className="hidden"
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const file = input.files?.[0];
          if (file) onImportFromFile(file);
          input.value = "";
        }}
      />
    </div>
  );
}

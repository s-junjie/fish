import { Play } from "lucide-react";
import { t } from "../../i18n";
import type { AutosaveStatus } from "../../core/persistence/autosave-controller";
import { TITLE_BAR_HEIGHT } from "./titlebar-layout";
import { AutosaveBadge } from "./AutosaveBadge";
import { LogoMenu } from "./LogoMenu";
import type { UpdateStatus } from "../hooks/useUpdateStatus";
import { ZoomControl } from "./ZoomControl";

interface TitleBarProps {
  hidden: boolean;
  docName: string | null;
  /** Null until the auto-save controller reports; the bar says nothing rather than guessing. */
  autosaveStatus: AutosaveStatus | null;
  /** Transient result of a manual save, already localised by the write-back hook. */
  saveStatus: string;
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
  canUseFilePicker: boolean;
  onPresent: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onZoomActualSize: () => void;
  /** Version, check and update. App-level, so it is not the hub's business. */
  updates: UpdateStatus;
}

/**
 * The window title bar: file identity, auto-save status and activation, manual
 * save/history controls, presentation mode, and the canvas zoom readout.
 *
 * Updates belongs to the file, so it sits at the left immediately after the
 * document name. Zoom is the one live number in the bar and the thing you
 * glance at while the pointer is on the canvas, so it takes the right side;
 * Present keeps the outer corner, past a `rule` seam. Both clusters are
 * carried by the measured `data-ui-panel` edge, so `unobstructedArea` can see
 * them.
 */
export function TitleBar({
  hidden,
  docName,
  autosaveStatus,
  saveStatus,
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
  canUseFilePicker,
  onPresent,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  onZoomActualSize,
  updates
}: TitleBarProps) {
  return (
    <div
      data-ui-panel="top"
      data-title-bar="true"
      style={{ height: TITLE_BAR_HEIGHT }}
      className={`absolute inset-x-0 top-0 flex items-center justify-between gap-3 border-b border-rule bg-panel px-3 z-50 transition-[transform,opacity] duration-300 ease-out ${
        hidden ? "-translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <LogoMenu status={updates} />
        {/* The document's name — the second of the three `font-sans` places,
            and the reference layout's own `.tb-title` (13px/600), the only text
            it draws in sans. It was stock `text-xs` and `ink-dim`, which made
            the one identity string in the chrome quieter than the metadata. */}
        <span data-title-bar-name="true" className="truncate font-sans text-displaySm text-ink max-w-[200px] md:max-w-[320px]">
          {docName ?? t("titlebar.untitled")}
        </span>
      </div>

      {/* Centered Auto-save / Document Hub */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center">
        <AutosaveBadge
          autosaveStatus={autosaveStatus}
          showActivateAutosave={showActivateAutosave}
          writebackTarget={writebackTarget}
          openedName={openedName}
          filePath={filePath}
          fileDirectory={fileDirectory}
          savedAsCopyOf={savedAsCopyOf}
          otherTabActive={otherTabActive}
          onActivateAutosave={onActivateAutosave}
          onSave={onSave}
          onSaveAs={onSaveAs}
          onNewFile={onNewFile}
          onOpenHistory={onOpenHistory}
          onExportJson={onExportJson}
          onImportJson={onImportJson}
          onImportFromFile={onImportFromFile}
          canUseFilePicker={canUseFilePicker}
        />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {saveStatus && <span className="mr-1 text-ui text-brand font-semibold">{saveStatus}</span>}

        <div data-zoom-bar="true" className="flex items-center">
          <ZoomControl
            zoom={zoom}
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
            onZoomFit={onZoomFit}
            onZoomActualSize={onZoomActualSize}
          />
        </div>

        <div className="ml-1 pl-3 border-l border-rule flex items-center">
          <button
            onClick={onPresent}
            data-present-button="true"
            className="p-1.5 rounded-full text-brand hover:text-ink transition-colors"
            title={t("titlebar.present")}
            aria-label={t("present.enter")}
          >
            <Play size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

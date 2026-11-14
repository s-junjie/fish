import { DesignDocument } from "../../core/dsl/types";
import { EditorStore } from "../../core/store/editor-store";
import {
  AutosaveController,
  type AutosaveStatus
} from "../../core/persistence/autosave-controller";
import { computeContentHash } from "../../core/persistence/recovery";
import { setFileStamp } from "../../core/persistence/file-stamp";
import {
  loadHandle,
  persistHandle,
  forgetHandle,
  verifyRestoredHandle,
  queryWritebackPermission,
  writebackTargetName
} from "../../core/persistence/writeback";
import {
  documentFromHtml,
  getFileId,
  FILE_ID_META_RE,
  getLoadFailure,
  getOpenedFileHash,
  readFileBackup,
  setFileHandle,
  adoptFileId,
  payloadHashFromHtml
} from "../../core/data-bridge";
import { applyDocumentTitle } from "../../core/document-title";

function commentsChanged(loaded: unknown, recovered: unknown): boolean {
  const normalize = (raw: unknown) =>
    JSON.stringify(raw && typeof raw === "object" ? raw : { version: "0.1", threads: [] });
  return normalize(loaded) !== normalize(recovered);
}

export interface BootRestoreParams {
  store: EditorStore;
  controller: AutosaveController;
  openedDocName: string | undefined;
  commentsLoaded: unknown;
  hasComments: boolean;
  latestBaseline: (doc: DesignDocument) => DesignDocument;
  armWriteback: (controller: AutosaveController) => boolean;
  setRecoveredComments: (comments: unknown) => void;
  setPendingRecovery: (doc: DesignDocument | null) => void;
  setLoadFailed: (failed: boolean) => void;
  setAutosaveStatus: (status: AutosaveStatus | null) => void;
  setShowActivateAutosave: (show: boolean) => void;
  setWritebackTarget: (target: string | null) => void;
}

export function restoreWritebackOnBoot(params: BootRestoreParams): void {
  const {
    store,
    controller,
    openedDocName,
    commentsLoaded,
    hasComments,
    latestBaseline,
    armWriteback,
    setRecoveredComments,
    setPendingRecovery,
    setLoadFailed,
    setAutosaveStatus,
    setShowActivateAutosave,
    setWritebackTarget
  } = params;

  void loadHandle(getFileId())
    .then(async () => {
      // Settle fork and reclaim abandoned rows before reading history or recovery.
      await controller.ready();
      await controller.reclaimAbandonedForks();
      controller.enable();
      const pending = await controller.checkRecovery(store.getDoc());
      const recovered = hasComments ? await controller.recoveryComments() : undefined;
      const commentsOnly =
        !pending &&
        recovered !== undefined &&
        commentsChanged(commentsLoaded, recovered);
      if (pending || commentsOnly) {
        setRecoveredComments(recovered);
        setPendingRecovery(pending ?? store.getDoc());
      } else if (getLoadFailure()) {
        const backup = await readFileBackup(getFileId());
        const restored = backup ? documentFromHtml(backup) : undefined;
        if (restored) setPendingRecovery(restored);
        else setLoadFailed(true);
      }
      const perm = await queryWritebackPermission();
      if (perm === "granted") {
        const check = await verifyRestoredHandle(
          getFileId(),
          getOpenedFileHash(),
          openedDocName
        );
        if (check.ok) {
          // Verified handle already matches disk; arm without flushing to avoid racing font rebaselining.
          if (armWriteback(controller)) {
            setAutosaveStatus({
              kind: "file-saved",
              at: new Date().toISOString(),
              doc: latestBaseline(store.getDoc())
            });
          }
        } else {
          setFileHandle(null);
          await forgetHandle(getFileId()).catch(() => undefined);
          setShowActivateAutosave(true);
        }
      } else {
        setShowActivateAutosave(true);
      }
      setWritebackTarget(writebackTargetName() ?? null);
    })
    .catch((err) => {
      console.error("FISH: auto-save startup failed:", err);
      setShowActivateAutosave(true);
    });
}

export interface LaunchQueueParams {
  store: EditorStore;
  controller: AutosaveController;
  markSaved: (doc: DesignDocument) => void;
  armWriteback: (controller: AutosaveController) => boolean;
  setWritebackTarget: (target: string | null) => void;
  setShowActivateAutosave: (show: boolean) => void;
}

export function registerLaunchQueueConsumer(params: LaunchQueueParams): void {
  if (
    typeof window === "undefined" ||
    !("launchQueue" in window) ||
    typeof (window as any).launchQueue?.setConsumer !== "function"
  ) {
    return;
  }

  const { store, controller, markSaved, armWriteback, setWritebackTarget, setShowActivateAutosave } =
    params;

  (window as any).launchQueue.setConsumer(async (launchParams: { files?: any[] }) => {
    const handle = launchParams?.files?.[0];
    if (!handle) return;
    try {
      setFileHandle(handle);
      const file = await handle.getFile?.();
      if (typeof file?.lastModified === "number") setFileStamp(file.lastModified);
      const text = await file?.text?.();
      if (text) {
        const writtenId = FILE_ID_META_RE.exec(text)?.[1];
        if (writtenId) adoptFileId(writtenId);
        const doc = documentFromHtml(text);
        if (doc && computeContentHash(doc) !== computeContentHash(store.getDoc())) {
          store.commit(doc);
        }
        const hash = payloadHashFromHtml(text);
        await controller.noteFileSaved(store.getDoc(), hash);
        markSaved(store.getDoc());
      }
      void persistHandle(getFileId()).catch(() => undefined);
      armWriteback(controller);
      setWritebackTarget(handle.name ?? writebackTargetName() ?? null);
      applyDocumentTitle(handle.name, store.getDoc().name);
      setShowActivateAutosave(false);
    } catch (err) {
      console.warn("FISH: failed to adopt file from launchQueue:", err);
    }
  });
}

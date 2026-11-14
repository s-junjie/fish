import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getActivePage } from "../../core/dsl/document-ops";
import { DesignDocument } from "../../core/dsl/types";
import { EditorStore } from "../../core/store/editor-store";
import {
  AutosaveController,
  type AutosaveStatus
} from "../../core/persistence/autosave-controller";
import { IdbBackend, MemoryBackend, hasIndexedDb } from "../../core/persistence/backend";
import { createRecoveryStore } from "../../core/persistence/recovery";
import { createAssetStore } from "../../core/persistence/assets";
import { shouldWarnBeforeUnload } from "../../core/persistence/unload-guard";
import { createTimelineStore } from "../../core/persistence/timeline";
import { FILE_CHANGED_REASON, fileStamp, setFileStamp, rememberFileStamp } from "../../core/persistence/file-stamp";
import { inspectExternalUpdate } from "../../core/persistence/external-update";
import {
  persistHandle,
  forgetHandle,
  pickWritebackFile,
  verifyPickedFile,
  requestWritebackPermission,
  writeBackFile,
  writebackTargetName,
  saveDocAsNewFile,
  saveAsCopyName,
  readOnlyCopyName
} from "../../core/persistence/writeback";
import {
  TabCoordinator,
  createBroadcastTabChannel
} from "../../core/persistence/tab-coordinator";
import {
  documentFromHtml,
  getFileId,
  FILE_ID_META_RE,
  getOpenedFileHash,
  openedFileName,
  openedFilePath,
  openedFileDirectory,
  saveInPlace,
  getFileHandle,
  getFileName,
  setFileHandle,
  setOpenedFileHash,
  adoptFileId,
  payloadHashFromHtml,
  createEmptyDocument
} from "../../core/data-bridge";
import { createId } from "../../core/id";
import { applyDocumentTitle } from "../../core/document-title";
import { withActivePageViewport } from "../../core/interactions/page-ops";
import type { PageViewport } from "../../core/geometry/viewport";
import { t } from "../../i18n";
import { useSaveStatus } from "./useSaveStatus";
import { useDirtyBaseline } from "./useDirtyBaseline";
import { useVersionHistory } from "./useVersionHistory";
import { registerLaunchQueueConsumer, restoreWritebackOnBoot } from "./file-writeback-boot";

export type { SaveStatusKind, SaveStatusState } from "./useSaveStatus";

function defaultDocumentFileName(doc: DesignDocument, openedName: string | null): string {
  return openedName || `${(doc.name || "untitled").toLowerCase().replace(/\s+/g, "-")}.fish.html`;
}

export function useFileWriteback(
  store: EditorStore,
  viewportRef?: { current: PageViewport },
  comments?: { get: () => unknown; loaded: unknown }
) {
  const { saveStatus, flashSaveStatus, clearSaveStatus } = useSaveStatus();
  const [showActivateAutosave, setShowActivateAutosave] = useState(false);
  const [writebackTarget, setWritebackTarget] = useState<string | null>(null);
  const [docNameOverride, setDocNameOverride] = useState<string | null>(null);
  const [pickMismatch, setPickMismatch] = useState<{ reason: string; pickedName: string | null } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState<DesignDocument | null>(null);
  const [recoveredComments, setRecoveredComments] = useState<unknown>(undefined);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus | null>(null);
  const controllerRef = useRef<AutosaveController | null>(null);
  const tabRef = useRef<TabCoordinator | null>(null);
  const [otherTabActive, setOtherTabActive] = useState(false);
  const [fileConflict, setFileConflict] = useState(false);
  const fileConflictRef = useRef(false);
  fileConflictRef.current = fileConflict;
  const [fileUpdated, setFileUpdated] = useState(false);
  const seenDiskMtimeRef = useRef<number | null>(null);
  const dismissedDiskMtimeRef = useRef<number | null>(null);
  const checkingDiskRef = useRef(false);
  // Preserves desired write-back state while standing down for another active tab.
  const writebackWantedRef = useRef(false);

  const { latestBaseline, markSaved, getLastSavedDoc, isDirty } = useDirtyBaseline(
    store,
    () => controllerRef.current?.hasPendingWork() === true
  );

  const {
    versions,
    setVersions,
    showHistory,
    setShowHistory,
    showHistoryRef,
    previewingId,
    setPreviewingId,
    openHistory,
    closeHistory,
    previewVersion,
    exitPreview
  } = useVersionHistory(store, controllerRef);

  const armWriteback = useCallback((controller: AutosaveController | null): boolean => {
    if (tabRef.current?.isSuperseded()) {
      writebackWantedRef.current = true;
      return false;
    }
    controller?.setWritebackEnabled(true, { flush: false });
    return true;
  }, []);

  // Viewport is folded in only at write time so panning never enters undo history.
  const fileDoc = useCallback(
    () => (viewportRef ? withActivePageViewport(store.getDoc(), viewportRef.current) : store.getDoc()),
    [store]
  );

  const urlName = openedFileName() ?? null;
  const openedName = docNameOverride ?? urlName;
  // After save-as from `file://`, `window.location` still points at the original path.
  const savedAsCopyOf = docNameOverride && urlName && docNameOverride !== urlName ? urlName : null;
  // Exclude dev bundle routes (e.g. `/__fish_bundle__`) from file-name identity checks.
  const openedDocName =
    openedName && /\.html?$/i.test(openedName) ? openedName : undefined;

  useEffect(() => {
    const syncTitle = () => applyDocumentTitle(getFileName(), store.getDoc().name);
    syncTitle();
    return store.onHistory(syncTitle);
  }, [store, openedName, writebackTarget]);

  useEffect(() => {
    const backend = hasIndexedDb() ? new IdbBackend() : new MemoryBackend();
    const controller = new AutosaveController({
      getDoc: () => store.getDoc(),
      getWritebackDoc: fileDoc,
      getComments: comments?.get,
      subscribe: (cb) => store.subscribe(cb),
      recovery: createRecoveryStore(backend),
      assets: createAssetStore(backend),
      timeline: createTimelineStore(backend),
      historySubscribe: (cb) => store.onHistory(cb),
      applyDoc: (doc) => {
        store.setViewDoc(null);
        store.setReadOnly(null);
        setPreviewingId(null);
        store.commit(doc);
        if (showHistoryRef.current) store.setReadOnly("history-preview");
      },
      fileId: () => getFileId(),
      getFilePayloadHash: getOpenedFileHash,
      onStatus: (status) => {
        setAutosaveStatus(status);
        if (status.kind === "file-saved") {
          markSaved(status.doc);
          setFileUpdated(false);
        } else if (status.kind === "file-conflict") {
          writebackWantedRef.current = false;
          setFileUpdated(false);
          setFileConflict(true);
        }
      },
      onTimeline: setVersions
    });
    controllerRef.current = controller;

    const tabChannel = createBroadcastTabChannel();
    let onVisibilityChange: (() => void) | null = null;
    if (tabChannel) {
      const coordinator = new TabCoordinator(tabChannel, {
        fileId: getFileId(),
        tabId: createId("tab"),
        visible: typeof document === "undefined" || document.visibilityState !== "hidden",
        onSuperseded: () => {
          setOtherTabActive(true);
          writebackWantedRef.current = controller.isWritebackEnabled();
          void controller.suspendWriteback();
        },
        onRegained: () => {
          setOtherTabActive(false);
          if (!writebackWantedRef.current) return;
          writebackWantedRef.current = false;
          controller.setWritebackEnabled(true);
        }
      });
      coordinator.start();
      tabRef.current = coordinator;
      // `visibilitychange` fires immediately even in tabs whose heartbeat timers are throttled.
      onVisibilityChange = () =>
        coordinator.setVisibility(document.visibilityState !== "hidden");
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

      restoreWritebackOnBoot({
        store,
        controller,
        openedDocName,
        commentsLoaded: comments?.loaded,
        hasComments: Boolean(comments),
        latestBaseline,
        armWriteback,
        setRecoveredComments,
        setPendingRecovery,
        setLoadFailed,
        setAutosaveStatus,
        setShowActivateAutosave,
        setWritebackTarget
      });

      registerLaunchQueueConsumer({
        store,
        controller,
        markSaved,
        armWriteback,
        setWritebackTarget,
        setShowActivateAutosave
      });

      return () => {
        if (onVisibilityChange) document.removeEventListener("visibilitychange", onVisibilityChange);
        controller.disable();
        controllerRef.current = null;
        tabRef.current?.stop();
        tabRef.current = null;
      };
    }, [store, fileDoc, comments]);

    const rejectTarget = useCallback(
      async (reason: string, name: string | null, forget: boolean) => {
        if (forget) {
          setFileHandle(null);
          await forgetHandle(getFileId()).catch(() => undefined);
        }
        setPickMismatch({ reason, pickedName: name });
      },
      []
    );

    const activateAutosave = useCallback(async () => {
      try {
        const restored = getFileHandle();
        if (!restored) {
          const picked = await pickWritebackFile();
          if (!picked.ok) return;
          const check = await verifyPickedFile(
            picked.handle!,
            getOpenedFileHash(),
            openedDocName,
            getFileId()
          );
          if (!check.ok) {
            return rejectTarget(check.reason ?? "content-mismatch", picked.name ?? null, false);
          }
          setPickMismatch(null);
          setFileHandle(picked.handle!);
        }
        const perm = await requestWritebackPermission();
        if (perm !== "granted") {
          // Drop a denied restored handle so the next retry opens the picker instead of looping.
          if (restored && perm === "denied") {
            setFileHandle(null);
            await forgetHandle(getFileId()).catch(() => undefined);
            setWritebackTarget(writebackTargetName() ?? null);
          }
          setShowActivateAutosave(true);
          return;
        }
        if (restored) {
          const check = await verifyPickedFile(restored, getOpenedFileHash(), openedDocName, getFileId());
          if (!check.ok) {
            return rejectTarget(check.reason ?? "content-mismatch", restored.name ?? null, true);
          }
        }
        setPickMismatch(null);
          if (tabRef.current?.isSuperseded() !== true) {
            const written = store.getDoc();
            const res = await writeBackFile(fileDoc());
            if (!res.ok) {
              setAutosaveStatus({ kind: "file-unavailable", reason: res.reason ?? "write-failed" });
              return;
            }
            await controllerRef.current?.noteFileSaved(written, res.payloadHash);
            markSaved(written);
            setAutosaveStatus({ kind: "file-saved", at: new Date().toISOString(), doc: latestBaseline(written) });
          }
          void persistHandle(getFileId()).catch(() => undefined);
          armWriteback(controllerRef.current);
          setWritebackTarget(writebackTargetName() ?? null);
          setShowActivateAutosave(false);
        } catch (err) {
          console.error("FISH: enabling auto-save failed:", err);
          setShowActivateAutosave(true);
        }
  }, [openedDocName, rejectTarget, store, fileDoc, latestBaseline, markSaved, armWriteback]);

  const triggerSave = useCallback(async () => {
    const canPickWriteback = typeof window !== "undefined" && typeof (window as any).showOpenFilePicker === "function";
    if (canPickWriteback && (showActivateAutosave || !getFileHandle())) {
      await activateAutosave();
      return;
    }
    flashSaveStatus(t("app.saving"), "busy");
    const doc = fileDoc();
    // Captured before awaiting the write so concurrent edits stay marked unsaved.
    const sourceDoc = store.getDoc();
    try {
      const res = await saveInPlace(doc);
      if (res.success) {
        await controllerRef.current?.noteFileSaved(doc, res.payloadHash);
        if (res.method === "fsa") {
          void persistHandle(getFileId()).catch(() => undefined);
          armWriteback(controllerRef.current);
          setShowActivateAutosave(false);
        }
        markSaved(sourceDoc);
        setWritebackTarget(writebackTargetName() ?? null);
        applyDocumentTitle(res.filename, store.getDoc().name);
        flashSaveStatus(t("app.saved"));
      } else if (res.error === FILE_CHANGED_REASON) {
        clearSaveStatus();
        setFileConflict(true);
      } else {
        console.error("FISH: save failed:", res.error ?? "unknown");
        flashSaveStatus(t("app.saveFailed"), "error");
      }
    } catch (err) {
      console.error("FISH: save threw:", err);
      flashSaveStatus(t("app.saveFailed"), "error");
    }
}, [activateAutosave, showActivateAutosave, store, fileDoc, flashSaveStatus, clearSaveStatus, markSaved, armWriteback]);

const loadFromDisk = useCallback(async () => {
  const handle = getFileHandle();
  if (!handle) return;
  try {
    const file = await (handle as { getFile: () => Promise<File> }).getFile();
    const text = await file.text();
    const doc = documentFromHtml(text);
    if (!doc) {
      flashSaveStatus(t("autosave.loadFromDiskUnreadable"), "error");
      return;
    }
    const writtenId = FILE_ID_META_RE.exec(text)?.[1];
    if (writtenId) adoptFileId(writtenId);
    setFileStamp(file.lastModified);
    await controllerRef.current?.commitVersion({
      label: t("autosave.beforeLoadFromDisk"),
      kind: "pre-restore"
    });
    setFileConflict(false);
    setFileUpdated(false);
    seenDiskMtimeRef.current = null;
    dismissedDiskMtimeRef.current = null;
    setPendingRecovery(null);
    setPreviewingId(null);
    store.setViewDoc(null);
    store.setReadOnly(null);
    store.commit(doc);
    const hash = payloadHashFromHtml(text);
    setOpenedFileHash(hash);
    await controllerRef.current?.noteFileSaved(store.getDoc(), hash);
    markSaved(store.getDoc());
    void persistHandle(getFileId()).catch(() => undefined);
    writebackWantedRef.current = false;
    armWriteback(controllerRef.current);
    flashSaveStatus(t("autosave.loadedFromDisk"));
  } catch (err) {
    console.error("FISH: load from disk failed:", err);
    flashSaveStatus(t("autosave.loadFromDiskUnreadable"), "error");
  }
  }, [store, flashSaveStatus, markSaved, armWriteback, setPreviewingId]);

const keepMine = useCallback(async () => {
  const doc = fileDoc();
  const source = store.getDoc();
  const res = await writeBackFile(doc, { force: true });
  if (!res.ok) {
    setAutosaveStatus({ kind: "file-unavailable", reason: res.reason ?? "write-failed" });
    return;
  }
  await controllerRef.current?.noteFileSaved(source, res.payloadHash);
  markSaved(source);
  setFileConflict(false);
  setFileUpdated(false);
  seenDiskMtimeRef.current = null;
  dismissedDiskMtimeRef.current = null;
  writebackWantedRef.current = false;
  armWriteback(controllerRef.current);
  flashSaveStatus(t("app.saved"));
  }, [store, fileDoc, flashSaveStatus, markSaved, armWriteback]);

const triggerSaveAs = useCallback(async () => {
  flashSaveStatus(t("app.saving"), "busy");
  const doc = fileDoc();
  const sourceDoc = store.getDoc();
  const defaultName = saveAsCopyName(defaultDocumentFileName(doc, openedName));
  try {
    const res = await saveDocAsNewFile(doc, defaultName, undefined, { freshFileId: true });
    if (res.ok) {
      if (res.handle) {
        setFileHandle(res.handle);
        if (res.fileId) adoptFileId(res.fileId);
        await rememberFileStamp(res.handle);
        setOpenedFileHash(res.payloadHash);
        setDocNameOverride(res.name ?? null);
        writebackWantedRef.current = false;
        tabRef.current?.setFileId(getFileId());
        void persistHandle(getFileId()).catch(() => undefined);
        await controllerRef.current?.noteFileSaved(doc, res.payloadHash);
        armWriteback(controllerRef.current);
        setShowActivateAutosave(false);
      }
      markSaved(sourceDoc);
      setWritebackTarget(res.name ?? writebackTargetName() ?? null);
      applyDocumentTitle(res.name, store.getDoc().name);
      flashSaveStatus(t("app.saved"));
    } else if (res.reason === "aborted") {
      clearSaveStatus();
    } else {
      console.error("FISH: save-as failed:", res.reason ?? "unknown");
      flashSaveStatus(t("app.saveFailed"), "error");
    }
  } catch (err) {
    console.error("FISH: save-as threw:", err);
    flashSaveStatus(t("app.saveFailed"), "error");
  }
  }, [openedName, store, fileDoc, clearSaveStatus, flashSaveStatus, markSaved, armWriteback]);

const triggerSaveAsReadOnly = useCallback(async () => {
  flashSaveStatus(t("app.saving"), "busy");
  const doc = fileDoc();
  const defaultName = readOnlyCopyName(defaultDocumentFileName(doc, openedName));
  try {
      const res = await saveDocAsNewFile(doc, defaultName, undefined, {
        freshFileId: true,
        readOnly: true
      });
      if(res.ok) {
        flashSaveStatus(t("app.savedReadOnly"));
  } else if (res.reason === "aborted") {
    clearSaveStatus();
  } else {
    console.error("FISH: read-only copy failed:", res.reason ?? "unknown");
    flashSaveStatus(t("app.saveFailed"), "error");
  }
} catch (err) {
  console.error("FISH: read-only copy threw:", err);
  flashSaveStatus(t("app.saveFailed"), "error");
}
  }, [openedName, fileDoc, clearSaveStatus, flashSaveStatus]);

const triggerNewFile = useCallback(() => {
  const doc = store.getDoc();
  const hasContent =
    (getActivePage(doc).children && getActivePage(doc).children.length > 0) ||
    (doc.pages && doc.pages.some((p) => p.children && p.children.length > 0));
  if (hasContent) {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      if (!window.confirm(t("autosave.startFromScratchConfirm"))) {
        return;
      }
    }
  }
  store.commit(createEmptyDocument());
  flashSaveStatus(t("autosave.startedFromScratch"));
}, [store, flashSaveStatus]);

const checkForExternalUpdate = useCallback(async () => {
  if (checkingDiskRef.current) return;
  checkingDiskRef.current = true;
  try {
    const saved = getLastSavedDoc();
    const hasLocalEdits =
      fileConflictRef.current ||
      (saved !== null &&
        shouldWarnBeforeUnload({
          saved: latestBaseline(saved),
          current: latestBaseline(store.getDoc()),
          owed: controllerRef.current?.hasPendingWork() === true
        }));
    const outcome = await inspectExternalUpdate({
      handle: getFileHandle(),
      baselineStamp: fileStamp(),
      dismissedMtime: dismissedDiskMtimeRef.current,
      hasLocalEdits
    });
    if (outcome.status === "conflict") {
      writebackWantedRef.current = false;
      controllerRef.current?.setWritebackEnabled(false);
      setFileUpdated(false);
      setFileConflict(true);
    } else if (outcome.status === "updated") {
      seenDiskMtimeRef.current = outcome.mtime;
      setFileUpdated(true);
    } else if (outcome.status === "unchanged") {
      setFileUpdated(false);
    }
  } finally {
    checkingDiskRef.current = false;
  }
  }, [store, latestBaseline, getLastSavedDoc]);

useEffect(() => {
  if (typeof window === "undefined") return;
  const onFocus = () => {
    void checkForExternalUpdate();
  };
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void checkForExternalUpdate();
    }
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}, [checkForExternalUpdate]);

const dismissFileUpdated = useCallback(() => {
  dismissedDiskMtimeRef.current = seenDiskMtimeRef.current;
  setFileUpdated(false);
}, []);

const noteUpdatedFile = useCallback(
  async (payloadHash?: string) => {
    markSaved(store.getDoc());
    await controllerRef.current?.noteFileSaved(fileDoc(), payloadHash);
  },
  [store, fileDoc, markSaved]
);

return {
  saveStatus,
  flashSaveStatus,
  pendingRecovery,
  setPendingRecovery,
  recoveredComments,
  showActivateAutosave,
  openedName,
  openedDocName,
  otherTabActive,
  fileConflict,
  fileUpdated,
  loadFromDisk,
  keepMine,
  dismissFileUpdated,
  writebackTarget,
  loadFailed,
  pickMismatch,
  dismissPickMismatch: () => setPickMismatch(null),
  versions,
  autosaveStatus,
  showHistory,
  setShowHistory,
  controllerRef,
  triggerSave,
  triggerSaveAs,
  triggerSaveAsReadOnly,
  triggerNewFile,
  noteUpdatedFile,
  savedAsCopyOf,
  filePath: savedAsCopyOf ? undefined : openedFilePath(),
  fileDirectory: savedAsCopyOf ? undefined : openedFileDirectory(),
  activateAutosave,
  openHistory,
  closeHistory,
  previewVersion,
  exitPreview,
  previewingId,
    isDirty
};
}

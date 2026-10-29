import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import { DesignDocument } from "../../core/dsl/types";
import { EditorStore } from "../../core/store/editor-store";
import {
  AutosaveController,
  type AutosaveStatus,
  type VersionSummary
} from "../../core/persistence/autosave-controller";
import { IdbBackend, MemoryBackend, hasIndexedDb } from "../../core/persistence/backend";
import { createRecoveryStore, computeContentHash } from "../../core/persistence/recovery";
import { createAssetStore } from "../../core/persistence/assets";
import { shouldWarnBeforeUnload } from "../../core/persistence/unload-guard";
import { createTimelineStore } from "../../core/persistence/timeline";
import {
  loadHandle,
  persistHandle,
  forgetHandle,
  pickWritebackFile,
  verifyPickedFile,
  verifyRestoredHandle,
  queryWritebackPermission,
  requestWritebackPermission,
  writeBackFile,
  writebackTargetName,
  saveDocAsNewFile,
  saveAsCopyName
} from "../../core/persistence/writeback";
import {
  TabCoordinator,
  createBroadcastTabChannel
} from "../../core/persistence/tab-coordinator";
import {
  documentFromHtml,
  getFileId,
  getLoadFailure,
  getOpenedFileHash,
  openedFileName,
  openedFilePath,
  openedFileDirectory,
  readFileBackup,
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

/**
 * Owns everything about the file the tab is editing: auto-save, write-back
 * identity, crash recovery and the version timeline.
 *
 * It reads the document straight from the store rather than taking a ref — the
 * two are kept in step by every writer, and a second copy of "which document is
 * current" is one more thing that can disagree.
 *
 * The camera is the exception: it is not in the store at all, so it arrives as
 * a ref and is folded into the document at the moment of a write.
 */
/**
 * Whether the snapshot's conversation differs from the one the file holds.
 *
 * Compared as text, which is what both sides are: the snapshot stores the block
 * the app serialized, and `loaded` is the block parsed out of the file. Deep
 * equality would have to know the comment model, and this layer deliberately
 * does not.
 */
function commentsChanged(loaded: unknown, recovered: unknown): boolean {
  const normalize = (raw: unknown) =>
    JSON.stringify(raw && typeof raw === "object" ? raw : { version: "0.1", threads: [] });
  return normalize(loaded) !== normalize(recovered);
}

export function useFileWriteback(
  store: EditorStore,
  viewportRef?: { current: PageViewport },
  /**
   * The comment block: `get` is what the writer stores (stable identity — the
   * auto-save effect is built once), `loaded` is what the file held at boot, so
   * a conversation that only exists in the snapshot can be offered back.
   */
  comments?: { get: () => unknown; loaded: unknown }
) {
  const [saveStatus, setSaveStatus] = useState<string>("");
  const [showActivateAutosave, setShowActivateAutosave] = useState(false);
  // Which file write-back actually lands in. Without it a save-as leaves the
  // tab showing file A while every auto-save quietly rewrites file B.
  const [writebackTarget, setWritebackTarget] = useState<string | null>(null);
  // Set when a save-as adopts a new file in this tab. The URL cannot follow, so
  // this is what keeps the identity check, the title and the mismatch dialog
  // talking about the file auto-save is actually writing to.
  const [docNameOverride, setDocNameOverride] = useState<string | null>(null);
  // Set when the file chosen in the picker turns out not to be this tab's file.
  const [pickMismatch, setPickMismatch] = useState<{ reason: string; pickedName: string | null } | null>(null);
  // The file's document block could not be read and nothing could be recovered.
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState<DesignDocument | null>(null);
  /* The comment block that came with the pending snapshot. Untyped here for the
     same reason the record's field is: this hook stores bytes, and the comment
     module owns what they mean. */
  const [recoveredComments, setRecoveredComments] = useState<unknown>(undefined);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // The version whose document the canvas is showing, if any. Opening the panel
  // already makes the document read-only; this is the second, separate fact —
  // that the view has been redirected at a version.
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  // Read by the controller's `applyDoc` closure, which outlives any render the
  // state itself would be captured in.
  const showHistoryRef = useRef(showHistory);
  showHistoryRef.current = showHistory;
  // Serialises preview loads: two rows clicked in quick succession must end on
  // the second, not on whichever IndexedDB read happened to resolve last.
  const previewTokenRef = useRef(0);
  // What auto-save is doing right now. The controller always had this; until the
  // title bar there was nowhere to put it, so its strings sat unused in i18n.
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus | null>(null);
  const controllerRef = useRef<AutosaveController | null>(null);
  const tabRef = useRef<TabCoordinator | null>(null);
  const [otherTabActive, setOtherTabActive] = useState(false);
  // What the file is known to hold, as the document OBJECT that was written.
  //
  // A reference, not a hash: the comparison this feeds runs inside
  // `beforeunload`, and hashing a document that carries its bitmaps inline
  // costs ~50 ms of blocked main thread on every close. A commit replaces the
  // object, so identity answers "has anything been committed since the write
  // that landed" exactly — see `shouldWarnBeforeUnload`, which owns the rule.
  //
  // Assigned once on mount, never `useRef(store.getDoc())`: a ref's initial
  // expression is evaluated on every render and thrown away after the first.
  const lastSavedDocRef = useRef<DesignDocument | null>(null);
  if (lastSavedDocRef.current === null) lastSavedDocRef.current = store.getDoc();
  // True while this tab wants write-back but is standing down for another tab.
  // The controller's own flag is off in that state, so it cannot answer
  // "resume when the other tab leaves" on its own.
  const writebackWantedRef = useRef(false);

  /**
   * The document as it goes into a file: carrying the page the user is on and
   * the view they are on it with.
   *
   * Read at the moment of the write and never committed: a pan is not an edit,
   * and a viewport that lived in the document would put every wheel tick on the
   * undo stack and mark a file dirty that nothing but the camera has changed.
   */
  const fileDoc = useCallback(
    () => (viewportRef ? withActivePageViewport(store.getDoc(), viewportRef.current) : store.getDoc()),
    [store]
  );

  const urlName = openedFileName() ?? null;
  const openedName = docNameOverride ?? urlName;
  // The tab now writes to a file the URL cannot name. `window.location` is the
  // only path a `file://` page can read, and a handle does not reveal one, so
  // after a save-as the address bar keeps pointing at the original: everything
  // that would report a folder must fall silent rather than describe that file.
  const savedAsCopyOf = docNameOverride && urlName && docNameOverride !== urlName ? urlName : null;
  // The name the write-back identity check holds a picked file against. Only a
  // name that *is* a document counts: under the dev bundle route the pathname is
  // a route (`/__fish_bundle__`), not a file, so checking against it would
  // refuse every pick and leave auto-save permanently off in dev.
  const openedDocName =
    openedName && /\.html?$/i.test(openedName) ? openedName : undefined;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const saved = lastSavedDocRef.current;
      if (!saved) return;
      const dirty = shouldWarnBeforeUnload({
        saved,
        current: store.getDoc(),
        owed: controllerRef.current?.hasPendingWork() === true
      });
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [store]);

  // What the tab says: the file this tab is editing. `writebackTarget` is a
  // dependency because it is the only signal that the target can change — a save
  // turns "no file" into a file, a relink turns one file into another, and
  // neither touches `openedName`. The history channel catches the other half: a
  // document arriving under a new name (an import, a restore).
  useEffect(() => {
    const syncTitle = () => applyDocumentTitle(getFileName(), store.getDoc().name);
    syncTitle();
    return store.onHistory(syncTitle);
  }, [store, openedName, writebackTarget]);

  // Auto-save: crash recovery (always on) + optional file write-back.
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
        // The one write history mode allows: a restore replaces the live
        // document ON PURPOSE, and refusing it would leave the user in a mode
        // the only escape hatch from. The lift and the re-gate are one
        // synchronous run — no frame in which the editor is editable — and the
        // view goes back to the live document, which is now the restored one.
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
          // The document that reached the file, which is not necessarily the
          // one on screen now: the user can type during a write.
          lastSavedDocRef.current = status.doc;
        }
      },
      onTimeline: setVersions
    });
    controllerRef.current = controller;
    // Two tabs on the same file are last-writer-wins on disk. The lower tab id
    // keeps writing; the other stops and says so, rather than quietly losing
    // whichever flush lands second. On screen outranks arrival order: the
    // background tab is the one whose heartbeat the browser throttles, so it is
    // the one that has to hand the file over (see `TabCoordinator`).
    const tabChannel = createBroadcastTabChannel();
    let onVisibilityChange: (() => void) | null = null;
    if (tabChannel) {
      const coordinator = new TabCoordinator(tabChannel, {
        fileId: getFileId(),
        tabId: createId("tab"),
        visible: typeof document === "undefined" || document.visibilityState !== "hidden",
        onSuperseded: () => {
          setOtherTabActive(true);
          // Persist the debounced edit before standing down: as a follower this
          // tab will not flush again, and the recovery snapshot is the only copy.
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
      // `visibilitychange` is not throttled, so this is the tab's chance to give
      // write-back up while it still can: a heartbeat timeout cannot be relied
      // on for the same job, because the tab that would have to answer it is the
      // one the browser has stopped waking up.
      onVisibilityChange = () =>
        coordinator.setVisibility(document.visibilityState !== "hidden");
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    void loadHandle(getFileId()).then(async () => {
      // Settle the fork before anything reads history or recovery: it is a
      // property of the file we just opened, not of the doc we are editing.
      await controller.ready();
      // Reclaim rows left by forks this file abandoned, before anything reads
      // history — otherwise they accumulate silently, invisible to retention.
      await controller.reclaimAbandonedForks();
      controller.enable();
      const pending = await controller.checkRecovery(store.getDoc());
      const recovered = comments ? await controller.recoveryComments() : undefined;
      /* A conversation is unsaved work too. `checkRecovery` answers about the
         document, and a session that only wrote comments leaves the document
         identical to the file — which used to mean those comments were dropped
         silently, because "nothing changed" was measured on the wrong thing. */
      const commentsOnly =
        !pending &&
        recovered !== undefined &&
        commentsChanged(comments?.loaded, recovered);
      if (pending || commentsOnly) {
        setRecoveredComments(recovered);
        setPendingRecovery(pending ?? store.getDoc());
      } else if (getLoadFailure()) {
        // The file's document block would not parse. Offer the copy we kept
        // before our last write; if there is none, say so plainly instead of
        // leaving the user staring at a blank canvas with their work gone.
        const backup = await readFileBackup(getFileId());
        const restored = backup ? documentFromHtml(backup) : undefined;
        if (restored) setPendingRecovery(restored);
        else setLoadFailed(true);
      }
      // Re-arm write-back on reload. The handle survives in IndexedDB but its
      // permission does not, so ask: a still-granted handle resumes silently,
      // anything else surfaces the activation prompt instead of leaving
      // write-back silently off with no way back in.
      const perm = await queryWritebackPermission();
      if (perm === "granted") {
        // Same proof the interactive path demands, on the path that used to skip
        // it. A granted permission only says "this browser may write to that
        // handle" — not that the handle is the file open in this tab, and a copy
        // of a file looks up the original's handle.
        const check = await verifyRestoredHandle(
          getFileId(),
          getOpenedFileHash(),
          openedDocName
        );
        if (check.ok) {
          // `loadHandle` runs after `coordinator.start()`, so another tab may
          // already own this file. Arming here would undo the suspension.
          if (tabRef.current?.isSuperseded()) writebackWantedRef.current = true;
          else controller.setWritebackEnabled(true);
        } else {
          setFileHandle(null);
          await forgetHandle(getFileId()).catch(() => undefined);
          setShowActivateAutosave(true);
        }
      } else {
        setShowActivateAutosave(true);
      }
      setWritebackTarget(writebackTargetName() ?? null);
    }).catch((err) => {
      // This chain gates every auto-save affordance. An unhandled rejection
      // anywhere in it — a blocked IndexedDB upgrade, a storage error — would
      // silently remove the prompts and leave the user with no way in, so the
      // failure has to surface both in the console and on screen.
      console.error("FISH: auto-save startup failed:", err);
      setShowActivateAutosave(true);
    });

    if (typeof window !== "undefined" && "launchQueue" in window && typeof (window as any).launchQueue?.setConsumer === "function") {
      (window as any).launchQueue.setConsumer(async (launchParams: { files?: any[] }) => {
        const handle = launchParams?.files?.[0];
        if (!handle) return;
        try {
          setFileHandle(handle);
          const file = await handle.getFile?.();
          const text = await file?.text?.();
          if (text) {
            const writtenId = (/<meta\s+name=["']fish:fileId["']\s+content=["']([^"']+)["']/i).exec(text)?.[1];
            if (writtenId) adoptFileId(writtenId);
            const doc = documentFromHtml(text);
            if (doc && computeContentHash(doc) !== computeContentHash(store.getDoc())) {
              store.commit(doc);
            }
            const hash = payloadHashFromHtml(text);
            await controller.noteFileSaved(store.getDoc(), hash);
            lastSavedDocRef.current = store.getDoc();
          }
          void persistHandle(getFileId()).catch(() => undefined);
          // The launched file already holds this document; enabling write-back
          // must not rewrite it just to arrive at the same bytes.
          if (tabRef.current?.isSuperseded()) writebackWantedRef.current = true;
          else controller.setWritebackEnabled(true, { flush: false });
          setWritebackTarget(handle.name ?? writebackTargetName() ?? null);
          applyDocumentTitle(handle.name, store.getDoc().name);
          setShowActivateAutosave(false);
        } catch (err) {
          console.warn("FISH: failed to adopt file from launchQueue:", err);
        }
      });
    }

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

  // Activate silent file write-back. The user must point at the file that is
  // already open — never "save as": a tab opened from `file://` cannot navigate
  // to a newly created file, so auto-save would quietly rewrite a file the user
  // is not looking at while the URL still shows the original.
  const activateAutosave = useCallback(async () => {
    try {
      const restored = getFileHandle();
      if (!restored) {
        const picked = await pickWritebackFile();
        if (!picked.ok) {
          // Cancellation is not an error: keep the prompt up and let them retry.
          if (picked.reason === "aborted") return;
          return;
        }
        // Read the picked file and compare it with what this tab loaded. Without
        // this the feature is a trap: one wrong click in the picker redirects
        // every later auto-save at a file the user is not looking at. The name
        // is checked too — content alone cannot tell one empty shell from the
        // next.
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
        // A restored handle the user refused would otherwise be asked about on
        // every retry: activation skips the picker while a handle exists, so the
        // only way back to "choose a file" is to drop it.
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
      // Another tab owning this file must not receive a write from this one.
      // The handle and permission are still worth keeping: they are what lets
      // write-back resume when that tab leaves.
      const superseded = tabRef.current?.isSuperseded() === true;
      if (!superseded) {
        // Bring the target up to date immediately, so the file and the tab agree
        // from the first flush onward rather than only after the next edit.
        const written = store.getDoc();
        const res = await writeBackFile(fileDoc());
        if (!res.ok) {
          setAutosaveStatus({ kind: "file-unavailable", reason: res.reason ?? "write-failed" });
          return;
        }
        await controllerRef.current?.noteFileSaved(written, res.payloadHash);
        lastSavedDocRef.current = written;
        setAutosaveStatus({ kind: "file-saved", at: new Date().toISOString(), doc: written });
      }
      // Remembering the handle only saves the user a re-pick next time. It must
      // never be able to block the feature: a full or unavailable IndexedDB
      // would otherwise turn "storage is unhappy" into "auto-save is broken".
      void persistHandle(getFileId()).catch(() => undefined);
      if (superseded) writebackWantedRef.current = true;
      else controllerRef.current?.setWritebackEnabled(true, { flush: false });
      setWritebackTarget(writebackTargetName() ?? null);
      setShowActivateAutosave(false);
    } catch (err) {
      // Leaving the prompt up is the right recovery, but silently is not: this
      // is the only entry point to write-back, and a bare "nothing happened" is
      // impossible to diagnose from the outside.
      console.error("FISH: enabling auto-save failed:", err);
      setShowActivateAutosave(true);
    }
  }, [openedDocName, rejectTarget, store, fileDoc]);

  const triggerSave = useCallback(async () => {
    // Without `showOpenFilePicker` there is no handle to arm, so ⌘S must take
    // `saveInPlace` down its download path instead of opening a prompt that can
    // never succeed.
    const canPickWriteback = typeof window !== "undefined" && typeof (window as any).showOpenFilePicker === "function";
    if (canPickWriteback && (showActivateAutosave || !getFileHandle())) {
      await activateAutosave();
      return;
    }
    setSaveStatus(t("app.saving"));
    const doc = fileDoc();
    // The document the write is about to serialize. Captured here, not read
    // after the await: an edit during the write must leave the guard saying
    // "unsaved", or closing the tab would discard it without a prompt.
    const sourceDoc = store.getDoc();
    try {
      const res = await saveInPlace(doc);
      if (res.success) {
        // Re-anchor the fork and refresh the recovery snapshot: the file now
        // holds this content, so a later boot must not read our own write as a
        // foreign edit, nor offer to "recover" back to the pre-save state.
        await controllerRef.current?.noteFileSaved(doc, res.payloadHash);
        if (res.method === "fsa") {
          void persistHandle(getFileId()).catch(() => undefined);
          if (tabRef.current?.isSuperseded()) writebackWantedRef.current = true;
          else controllerRef.current?.setWritebackEnabled(true, { flush: false });
          setShowActivateAutosave(false);
        }
        lastSavedDocRef.current = sourceDoc;
        setWritebackTarget(writebackTargetName() ?? null);
        // The save named the file it wrote — a picker name this tab had no other
        // way to learn, and on the download path the only file the work now has.
        applyDocumentTitle(res.filename, store.getDoc().name);
        setSaveStatus(t("app.saved"));
      } else {
        console.error("FISH: save failed:", res.error ?? "unknown");
        setSaveStatus(t("app.saveFailed"));
      }
    } catch (err) {
      // The download fallback serializes unguarded, so a throw is a real
      // outcome here. Left uncaught it rejects into a bare `onSave` call, which
      // leaves the status on "Saving…" — a save that never happened then reads
      // as one that is merely slow.
      console.error("FISH: save threw:", err);
      setSaveStatus(t("app.saveFailed"));
    }
    setTimeout(() => setSaveStatus(""), 3000);
  }, [activateAutosave, showActivateAutosave, store, fileDoc]);

  const triggerSaveAs = useCallback(async () => {
    setSaveStatus(t("app.saving"));
    const doc = fileDoc();
    // Same capture as `triggerSave`: the new file holds this document, whatever
    // is committed while the picker and the write are open is not in it.
    const sourceDoc = store.getDoc();
    const currentName = openedName || `${(doc.name || "untitled").toLowerCase().replace(/\s+/g, "-")}.fish.html`;
    const defaultName = saveAsCopyName(currentName);
    try {
      const res = await saveDocAsNewFile(doc, defaultName, undefined, { freshFileId: true });
      if (res.ok) {
        if (res.handle) {
          setFileHandle(res.handle);
          if (res.fileId) adoptFileId(res.fileId);
          // This tab now edits the new file: the identity check must hold picks
          // against its name and bytes, the tab coordinator must guard its
          // channel, and the handle belongs under its id.
          setOpenedFileHash(res.payloadHash);
          setDocNameOverride(res.name ?? null);
          // The save-as has already written the new file; suppress the flush
          // `onRegained` would otherwise issue while switching identity.
          writebackWantedRef.current = false;
          tabRef.current?.setFileId(getFileId());
          void persistHandle(getFileId()).catch(() => undefined);
          await controllerRef.current?.noteFileSaved(doc, res.payloadHash);
          if (tabRef.current?.isSuperseded()) writebackWantedRef.current = true;
          else controllerRef.current?.setWritebackEnabled(true, { flush: false });
          setShowActivateAutosave(false);
        }
        lastSavedDocRef.current = sourceDoc;
        setWritebackTarget(res.name ?? writebackTargetName() ?? null);
        applyDocumentTitle(res.name, store.getDoc().name);
        setSaveStatus(t("app.saved"));
      } else if (res.reason === "aborted") {
        setSaveStatus("");
        return;
      } else {
        console.error("FISH: save-as failed:", res.reason ?? "unknown");
        setSaveStatus(t("app.saveFailed"));
      }
    } catch (err) {
      console.error("FISH: save-as threw:", err);
      setSaveStatus(t("app.saveFailed"));
    }
    setTimeout(() => setSaveStatus(""), 3000);
  }, [openedName, store, fileDoc]);

  /**
   * Reset the current document to a clean blank canvas (Bento style).
   * Confirms with the user if the document currently contains elements.
   * Committed through `store.commit` so it is undoable via ⌘Z.
   */
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
    setSaveStatus(t("autosave.startedFromScratch"));
    setTimeout(() => setSaveStatus(""), 3000);
  }, [store]);

  /**
   * Opening the panel is entering history mode: the panel open IS the mode, so
   * the document stops being writable from the first moment — before any row
   * is clicked, while the view still shows the live document.
   */
  const openHistory = useCallback(() => {
    setShowHistory(true);
    store.setReadOnly("history-preview");
    void controllerRef.current?.listVersions().then(setVersions);
  }, [store]);

  /** Leaving the panel is the whole exit: view back to live, writes back on. */
  const closeHistory = useCallback(() => {
    setShowHistory(false);
    previewTokenRef.current++;
    setPreviewingId(null);
    store.setViewDoc(null);
    store.setReadOnly(null);
  }, [store]);

  /**
   * Loads a version onto the canvas without restoring it. The document it
   * returns is a read of IndexedDB: nothing about the live document, the
   * timeline or auto-save changes, which is what makes entering and leaving a
   * version invisible to `saveStatus`.
   */
  const previewVersion = useCallback(
    async (id: string) => {
      if (previewingId === id) return;
      const token = ++previewTokenRef.current;
      const doc = await controllerRef.current?.previewVersion(id);
      if (!doc || token !== previewTokenRef.current) return;
      setPreviewingId(id);
      store.setViewDoc(doc);
    },
    [previewingId, store]
  );

  /** Back to the live document. The panel stays open, so it stays read-only. */
  const exitPreview = useCallback(() => {
    previewTokenRef.current++;
    setPreviewingId(null);
    store.setViewDoc(null);
  }, [store]);

  return {
    saveStatus,
    setSaveStatus,
    pendingRecovery,
    setPendingRecovery,
    recoveredComments,
    showActivateAutosave,
    openedName,
    openedDocName,
    otherTabActive,
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
    triggerNewFile,
    savedAsCopyOf,
    filePath: savedAsCopyOf ? undefined : openedFilePath(),
    fileDirectory: savedAsCopyOf ? undefined : openedFileDirectory(),
    activateAutosave,
    openHistory,
    closeHistory,
    previewVersion,
    exitPreview,
    previewingId,
    isDirty: () => lastSavedDocRef.current !== store.getDoc()
  };
}

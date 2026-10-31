import { useCallback, useState } from "preact/hooks";
import { t } from "../../i18n";
import { compactDocumentJson } from "../../core/document-json";
import { mergeDocumentPages } from "../../core/document-import";
import { pickDocumentJson, readDocumentJsonFile, saveDocumentJson, type PickedJson } from "../../core/persistence/json-file";
import { relayoutDocumentTree } from "../../core/compile";
import { readDroppedDocument } from "../../core/import/dropped-intake";
import type { DesignDocument } from "../../core/dsl/types";
import type { EditorStore } from "../../core/store/editor-store";
import type { SaveStatusKind } from "./useFileWriteback";

interface DocumentJsonActions {
  exportJson: () => Promise<boolean>;
  copyCompact: () => Promise<boolean>;
  /** The file the user picked, held until they choose which door to take it in by. */
  pendingImport: PickedJson | null;
  /** False where there is no `showOpenFilePicker`, so the row opens a file input. */
  canUseFilePicker: boolean;
  /** Returns the picker's promise so the menu can stay mounted until it closes. */
  openImport: () => Promise<void>;
  closeImport: () => void;
  pickImportFile: () => Promise<void>;
  /** The same door for a browser without the File System Access API. */
  importFromFile: (file: File) => void;
  /** One or more files dropped on the app: `.fish.json`, `.fish.html`, or a plugin zip. */
  importDroppedFiles: (files: readonly File[]) => Promise<void>;
  replaceWith: (doc: DesignDocument) => void;
  mergeWith: (doc: DesignDocument) => void;
}

/**
 * Moving a document out of this tab as `.fish.json`, and back in.
 *
 * The clipboard route is deliberately the small one now: `Copy compact JSON`
 * exists for an agent in the next chat message, while everything a person might
 * keep, diff or hand over goes through a file. Import asks which of two very
 * different things to do BEFORE it touches the document, because the two
 * answers are not alike — a merge is additive and lands beside what is already
 * here, a replace is the one operation in this menu that throws it away.
 */
export function useDocumentJsonActions(
  store: EditorStore,
  flashSaveStatus: (message: string, kind?: SaveStatusKind) => void
): DocumentJsonActions {
  const [pendingImport, setPendingImport] = useState<PickedJson | null>(null);

  const canUseFilePicker = typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";

  const exportJson = useCallback(async () => {
    const res = await saveDocumentJson(store.getDoc());
    if (res.ok) flashSaveStatus(t("documentJson.exported"));
    // A cancelled picker is the user changing their mind, not something to report.
    else if (res.reason !== "aborted") flashSaveStatus(t("documentJson.exportFailed"), "error");
    return res.ok;
  }, [store, flashSaveStatus]);

  const copyCompact = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(compactDocumentJson(store.getDoc()));
      flashSaveStatus(t("documentJson.copiedCompact"));
      return true;
    } catch {
      flashSaveStatus(t("documentJson.copyFailed"), "error");
      return false;
    }
  }, [store, flashSaveStatus]);

  const closeImport = useCallback(() => setPendingImport(null), []);

  const adopt = useCallback((res: { ok: true; picked: PickedJson } | { ok: false; reason: string }) => {
    if (!res.ok) {
      if (res.reason !== "aborted") flashSaveStatus(t("documentJson.importUnreadable"), "error");
      return;
    }
    setPendingImport(res.picked);
  }, [flashSaveStatus]);

  const pickImportFile = useCallback(async () => {
    adopt(await pickDocumentJson());
  }, [adopt]);

  const importFromFile = useCallback(
    (file: File) => {
      void readDocumentJsonFile(file).then(adopt);
    },
    [adopt]
  );

  const openImport = useCallback(() => pickImportFile(), [pickImportFile]);

  /**
   * A dropped file asks nothing first — there was no picker to imply "this file
   * will open here" — so it wants its shape read before it can be offered, and a
   * file the reader does not recognise gets the sentence instead of nothing.
   *
   * Only the first file is taken: a document IMPORT has exactly one subject, and
   * inventing an order-pages-by-drop-position rule would be a second feature
   * nobody asked for. The rest are named rather than quietly dropped.
   */
  const importDroppedFiles = useCallback(
    async (files: readonly File[]) => {
      const [file, ...rest] = files;
      if (!file) return;
      const res = await readDroppedDocument(file, {
        // `busy`, not `ok`: a Figma bundle spends seconds unpacking bitmaps, and
        // the spinner is the only thing in the bar that says it is still working
        // rather than finished. Each tick restarts the same 3s timer, so the line
        // goes down on its own once the conversion stops reporting.
        onProgress: (stage, done, total) => {
          if (stage === "images" && total > 0)
            flashSaveStatus(t("figmaImport.progressImages", { n: done, k: total }), "busy");
        }
      });
      // A file this app cannot read is an outcome, not a no-op: the drop already
      // looked accepted, so saying nothing here is the silent swallow this whole
      // path exists to remove.
      if (!res.ok) {
        flashSaveStatus(res.message, "error");
        return;
      }
      adopt({ ok: true, picked: res.picked });
      // A note about the drop, not a failure — the one file that was handed over
      // did open, which is what the tick reports.
      if (rest.length > 0) flashSaveStatus(t("documentJson.dropSingleOnly"));
    },
    [adopt, flashSaveStatus]
  );

  /**
   * One undo step, and every page relaid out rather than just the active one:
   * the incoming JSON carries authored boxes, and a frame whose text reflowed on
   * the way out has to be measured before it is drawn again.
   */
  const replaceWith = useCallback(
    (incoming: DesignDocument) => {
      const doc: DesignDocument = {
        ...incoming,
        pages: incoming.pages.map((page) => ({ ...page, children: relayoutDocumentTree(page.children) }))
      };
      store.commit(doc);
      closeImport();
      flashSaveStatus(t("documentJson.replaced"));
    },
    [store, closeImport, flashSaveStatus]
  );

  const mergeWith = useCallback(
    (incoming: DesignDocument) => {
      store.commit(mergeDocumentPages(store.getDoc(), incoming));
      closeImport();
      flashSaveStatus(t("documentJson.merged", { pages: incoming.pages?.length ?? 1 }));
    },
    [store, closeImport, flashSaveStatus]
  );

  return {
    exportJson,
    copyCompact,
    pendingImport,
    canUseFilePicker,
    openImport,
    closeImport,
    pickImportFile,
    importFromFile,
    importDroppedFiles,
    replaceWith,
    mergeWith
  };
}
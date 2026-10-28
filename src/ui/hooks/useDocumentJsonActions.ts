import { useCallback, useState } from "preact/hooks";
import { t } from "../../i18n";
import { compactDocumentJson } from "../../core/document-json";
import { mergeDocumentPages } from "../../core/document-import";
import { pickDocumentJson, readDocumentJsonFile, saveDocumentJson, type PickedJson } from "../../core/persistence/json-file";
import { relayoutDocumentTree } from "../../core/compile";
import type { DesignDocument } from "../../core/dsl/types";
import type { EditorStore } from "../../core/store/editor-store";

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
  setSaveStatus: (message: string) => void
): DocumentJsonActions {
  const [pendingImport, setPendingImport] = useState<PickedJson | null>(null);

  const flash = useCallback(
    (message: string) => {
      setSaveStatus(message);
      setTimeout(() => setSaveStatus(""), 3000);
    },
    [setSaveStatus]
  );

  const canUseFilePicker = typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";

  const exportJson = useCallback(async () => {
    const res = await saveDocumentJson(store.getDoc());
    if (res.ok) flash(t("documentJson.exported"));
    // A cancelled picker is the user changing their mind, not something to report.
    else if (res.reason !== "aborted") flash(t("documentJson.exportFailed"));
    return res.ok;
  }, [store, flash]);

  const copyCompact = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(compactDocumentJson(store.getDoc()));
      flash(t("documentJson.copiedCompact"));
      return true;
    } catch {
      flash(t("documentJson.copyFailed"));
      return false;
    }
  }, [store, flash]);

  const closeImport = useCallback(() => setPendingImport(null), []);

  const adopt = useCallback((res: { ok: true; picked: PickedJson } | { ok: false; reason: string }) => {
    if (!res.ok) {
      if (res.reason !== "aborted") flash(t("documentJson.importUnreadable"));
      return;
    }
    setPendingImport(res.picked);
  }, [flash]);

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
      flash(t("documentJson.replaced"));
    },
    [store, closeImport, flash]
  );

  const mergeWith = useCallback(
    (incoming: DesignDocument) => {
      store.commit(mergeDocumentPages(store.getDoc(), incoming));
      closeImport();
      flash(t("documentJson.merged", { pages: incoming.pages?.length ?? 1 }));
    },
    [store, closeImport, flash]
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
    replaceWith,
    mergeWith
  };
}
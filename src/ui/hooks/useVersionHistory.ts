import { useCallback, useRef, useState } from "preact/hooks";
import { EditorStore } from "../../core/store/editor-store";
import { AutosaveController, type VersionSummary } from "../../core/persistence/autosave-controller";

export function useVersionHistory(
  store: EditorStore,
  controllerRef: { current: AutosaveController | null }
) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const showHistoryRef = useRef(showHistory);
  showHistoryRef.current = showHistory;
  const previewTokenRef = useRef(0);

  const openHistory = useCallback(() => {
    setShowHistory(true);
    store.setReadOnly("history-preview");
    void controllerRef.current?.listVersions().then(setVersions);
  }, [store, controllerRef]);

  const closeHistory = useCallback(() => {
    setShowHistory(false);
    previewTokenRef.current++;
    setPreviewingId(null);
    store.setViewDoc(null);
    store.setReadOnly(null);
  }, [store]);

  const previewVersion = useCallback(
    async (id: string) => {
      if (previewingId === id) return;
      const token = ++previewTokenRef.current;
      const doc = await controllerRef.current?.previewVersion(id);
      if (!doc || token !== previewTokenRef.current) return;
      setPreviewingId(id);
      store.setViewDoc(doc);
    },
    [previewingId, store, controllerRef]
  );

  const exitPreview = useCallback(() => {
    previewTokenRef.current++;
    setPreviewingId(null);
    store.setViewDoc(null);
  }, [store]);

  return {
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
  };
}

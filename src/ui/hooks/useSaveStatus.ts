import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export type SaveStatusKind = "busy" | "ok" | "error";

export interface SaveStatusState {
  text: string;
  kind: SaveStatusKind;
}

const SAVE_STATUS_MS = 3000;

export function useSaveStatus() {
  const [saveStatus, setSaveStatus] = useState<SaveStatusState | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) {
        clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
    };
  }, []);

  const flashSaveStatus = useCallback((text: string, kind: SaveStatusKind = "ok") => {
    if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
    setSaveStatus({ text, kind });
    statusTimerRef.current = setTimeout(() => {
      statusTimerRef.current = null;
      setSaveStatus(null);
    }, SAVE_STATUS_MS);
  }, []);

  const clearSaveStatus = useCallback(() => {
    if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = null;
    setSaveStatus(null);
  }, []);

  return { saveStatus, flashSaveStatus, clearSaveStatus };
}

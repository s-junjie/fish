import { useCallback } from "preact/hooks";
import { DesignDocument } from "../../core/dsl/types";
import { parseFishDocument, importComponentsFromDocument } from "../../core/interactions/import-components";
import { t } from "../../i18n";

interface ComponentImportOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  setHintMessage: (message: string) => void;
}

/**
 * Pull main components out of another FISH file and into this document.
 *
 * The failure message is not optional here. `importComponentsFromDocument`
 * returns the names it actually took, and a file that contributed none looks
 * exactly like a file that was never read — so the count is what the two
 * outcomes are told apart by, and both are said out loud.
 */
export function useComponentImport({ docRef, commitSnapshot, setHintMessage }: ComponentImportOptions) {
  return useCallback(
    async (file: File) => {
      try {
        const source = parseFishDocument(await file.text());
        const result = source ? importComponentsFromDocument(docRef.current, source) : null;
        if (!result || result.names.length === 0) {
          setHintMessage(t("assets.importFailed"));
          return;
        }
        commitSnapshot(result.doc);
        setHintMessage(t("assets.imported"));
      } catch {
        setHintMessage(t("assets.importFailed"));
      }
    },
    [docRef, commitSnapshot, setHintMessage]
  );
}

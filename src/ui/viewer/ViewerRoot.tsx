import { useBlockBrowserZoom } from "../hooks/useBlockBrowserZoom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useEditorStore } from "../hooks/useEditorStore";
import { useFontStatusSync } from "../hooks/useFontStatusSync";
import { useReadOnlyLock } from "../hooks/useReadOnlyLock";
import { ViewerShell } from "./ViewerShell";

export interface ViewerRootProps {
  /** The file's own policy, read once by the entry. */
  readOnly: boolean;
}

/**
 * The reader, assembled.
 *
 * It owns a store because the document has to be loaded to be read, and nothing
 * else: no file write-back, no auto-save, no editing hooks. That is what makes
 * "a read-only file never starts an editor" true at assembly time rather than
 * by a guard at the bottom of a render.
 */
export function ViewerRoot({ readOnly }: ViewerRootProps) {
  useBlockBrowserZoom();
  const { store, doc, docRef } = useEditorStore();
  useReadOnlyLock(store, readOnly);
  useFontStatusSync(doc);
  useDocumentTitle(doc);

  return <ViewerShell doc={doc} docRef={docRef} readOnly={readOnly} />;
}

import { useEffect } from "preact/hooks";
import { getFileName } from "../../core/data-bridge";
import { applyDocumentTitle } from "../../core/document-title";
import type { DesignDocument } from "../../core/dsl/types";

/**
 * The tab's name, for the shells that have no file writer to set it.
 *
 * The editor learns it from `useFileWriteback`, which already tracks the name a
 * save writes to. A reader or an embed has no writer, but it is still showing a
 * named file — a review copy whose tab reads `FISH` instead of `poster` is the
 * kind of difference that only shows up after the change has shipped.
 */
export function useDocumentTitle(doc: DesignDocument) {
  useEffect(() => {
    applyDocumentTitle(getFileName(), doc.name);
  }, [doc.name]);
}

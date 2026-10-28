import { useEffect } from "preact/hooks";
import type { DesignDocument } from "../../core/dsl/types";
import { refreshFontStatus } from "../../core/fonts/font-status";

/**
 * Keep the font resolver's answer in step with the document it is about.
 *
 * Called from the editor root rather than from the canvas: `missing` is a fact
 * about the FILE on this machine, so it has to be known before anything paints —
 * including the layer panel and the export, which never touch the canvas
 * renderer.
 */
export function useFontStatusSync(doc: DesignDocument | null): void {
  useEffect(() => {
    refreshFontStatus(doc);
  }, [doc]);
}

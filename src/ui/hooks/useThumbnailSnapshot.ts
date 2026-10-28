import { useEffect } from "preact/hooks";
import type { DesignDocument } from "../../core/dsl/types";
import { primeThumbnailSnapshot } from "../thumbnail-snapshot";

/**
 * Keep the rasterized cover ready before it is needed.
 *
 * Saves are synchronous and must not wait for a decode, so the bitmap is built
 * on a pause instead: the debounce and the staleness check both live in
 * `thumbnail-snapshot`, which makes this a one-line subscription on the
 * document — the same shape as every other "observe the doc" effect.
 */
export function useThumbnailSnapshot(doc: DesignDocument): void {
  useEffect(() => {
    primeThumbnailSnapshot(doc);
  }, [doc]);
}

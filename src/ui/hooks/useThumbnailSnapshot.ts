import { useEffect } from "preact/hooks";
import type { DesignDocument } from "../../core/dsl/types";
import { cancelThumbnailSnapshot, primeThumbnailSnapshot } from "../thumbnail-snapshot";

/**
 * Keep the rasterized cover ready before it is needed.
 *
 * Saves are synchronous and must not wait for a decode, so the bitmap is built
 * on a pause instead: the debounce and the staleness check both live in
 * `thumbnail-snapshot`, which makes this a one-line subscription on the
 * document — the same shape as every other "observe the doc" effect.
 *
 * `paused` is a gesture in flight. A drag redraws the document every frame, so
 * the debounce never settles — and the pause a slow drag does leave is exactly
 * when a 1600px encode would land, mid-gesture, rasterizing a cover of a state
 * the next frame replaces. Waiting for the gesture to close costs nothing: the
 * document that matters is the one it left.
 */
export function useThumbnailSnapshot(doc: DesignDocument, paused = false): void {
  useEffect(() => {
    if (paused) {
      cancelThumbnailSnapshot();
      return;
    }
    primeThumbnailSnapshot(doc);
  }, [doc, paused]);
}

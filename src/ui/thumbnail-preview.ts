import type { DesignDocument } from "../core/dsl/types";
import { coverBlockHtml } from "../core/cover-block";
import { buildThumbnailSvg, thumbnailBackground } from "./thumbnail-svg";
import { cachedThumbnailSnapshot } from "./thumbnail-snapshot";
import { buildDefaultCover } from "./default-cover";

/**
 * The static first frame a saved file carries for whoever looks at it without
 * running its scripts: a file browser, a chat attachment card, a phone's preview
 * sheet. The block deletes itself the moment the editor boots, so a human
 * opening the file never sees it.
 *
 * Three sources, best picture first. A WebP snapshot primed ahead of the save — a
 * single `<img>` cannot be mis-painted by any engine, and it costs a fraction of
 * the SVG that has to carry the cover's bitmaps inline a second time. The SVG form
 * of the same art for a save that beats the encoder (the first save after opening,
 * or a keystroke inside the debounce). And the brand cover when there is no frame
 * to paint at all — an empty document, or one whose page nobody drew on. Returning
 * nothing in that last case is what left those files with no preview anywhere.
 */
export function renderThumbnailPreviewHtml(doc: DesignDocument): string {
  const snapshot = cachedThumbnailSnapshot(doc);
  if (snapshot) {
    return coverBlockHtml(
      `<img src="${snapshot.uri}" alt="" style="display:block;width:100%;height:100%;object-fit:contain">`,
      thumbnailBackground(doc)
    );
  }

  const art = buildThumbnailSvg(doc);
  if (art) return coverBlockHtml(art.svg, thumbnailBackground(doc));

  const cover = buildDefaultCover();
  return coverBlockHtml(cover.svg, cover.background);
}

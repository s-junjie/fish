/**
 * Splicing the cover block a saved file carries for whoever looks at it without
 * running its scripts: a file browser, a chat attachment card, a phone's preview
 * sheet.
 *
 * It sits in `core` beside the save rather than inside `data-bridge` so the two
 * regexes it owns — find the block, put the block ahead of the app — have one
 * definition and a test. A second copy is how the "replace, never stack" half
 * silently stops matching, and the failure is not an error: the previous cover
 * stays, or the new one lands beside it.
 */

/**
 * The block: a wrapper carrying the marker, the picture, and an end marker.
 *
 * The end marker is what makes the region findable. The wrapper's children are
 * divs too, so nothing in the markup itself says where the wrapper closes — the
 * first `</div>` belongs to the picture. A trailing empty div is unambiguous and
 * costs eight bytes.
 */
export const COVER_BLOCK_RE =
  /\s*<div\s+data-fish-preview="1"[^>]*>[\s\S]*?<div\s+data-fish-preview-end="1"[^>]*>\s*<\/div>\s*<\/div>/gi;

/**
 * The form files written before the end marker carry: the same wrapper, followed by
 * a script that deleted it. Kept so re-saving one of those files does not stack a
 * second cover on top of the first.
 */
export const LEGACY_COVER_BLOCK_RE =
  /\s*<div\s+data-fish-preview="1"[^>]*>[\s\S]*?<\/div>\s*<script\s+data-fish-preview="1"[^>]*>[\s\S]*?<\/script>/gi;

/**
 * Wrap one picture into a cover block: the paper, the picture, and the end marker.
 *
 * `inner` is an `<img>` when a rasterized snapshot was ready and an inline `<svg>`
 * when it was not — the block itself does not care which, and neither insertion
 * point (the save, the shell build) may spell its own.
 *
 * Deliberately scriptless. The block used to carry a one-line script that deleted
 * it on boot, which cost more than it looked: every saved file carried an inline
 * `<script>`, and the bundle that writes it cannot contain the literal close tag —
 * the shell inlines that bundle in a `<script>` of its own, so the HTML parser ended
 * the runtime at the first one and the editor booted into a `SyntaxError`. The
 * editor now clears the block when it starts, and the loader does the same before it
 * reports a decode failure, so a file that cannot boot shows its error rather than
 * a cover.
 */
export function coverBlockHtml(inner: string, background: string): string {
  // Break literal attribute tokens so stripCoverBlock regexes matching on an inlined
  // bundle (e.g. during shell assembly or reshelling) never match this function's
  // own minified source code. Terser does not constant-fold array joins.
  const previewAttr = ["data", "fish", 'preview="1"'].join("-");
  const previewEndAttr = ["data", "fish", 'preview-end="1"'].join("-");
  return (
    `<div ${previewAttr}><div style="position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:${background};overflow:hidden">${inner}</div><div ${previewEndAttr}></div></div>`
  );
}

/** Remove the cover from the live page. Called once the editor is about to paint. */
export function removeCoverFromDom(): void {
  if (typeof document === "undefined") return;
  const nodes = document.querySelectorAll("[data-fish-preview]");
  for (let i = nodes.length; i--; ) nodes[i].remove();
}

/** Drop any previous cover; a save that produces none leaves the file without. */
export function stripCoverBlock(html: string): string {
  return html.replace(COVER_BLOCK_RE, "").replace(LEGACY_COVER_BLOCK_RE, "");
}

/**
 * Put `block` where a viewer meets it first, replacing whatever was there.
 *
 * Ahead of the app's own markup rather than at the end of the body: the cover is
 * meant to paint before the editor exists, and a thumbnailer that stops at the
 * first paint only ever sees what is already in front of it.
 *
 * The anchor is the LAST match, not the first. A saved file carries its own runtime
 * as an inlined `<script>`, and that runtime contains the document templates as
 * text — `<body>` among them. Anchoring on the first occurrence spliced the cover
 * into the middle of that script, where it changed a template nobody could see and
 * left the real body without a cover. The document's own tags are after the runtime
 * that describes them, which is what makes "last" the honest answer.
 */
export function insertCoverBlock(html: string, block: string): string {
  const stripped = stripCoverBlock(html);
  const trimmed = block.trim();
  if (!trimmed) return stripped;

  const bodyAt = lastMatchEnd(stripped, /<body[^>]*>/i);
  if (bodyAt >= 0) return `${stripped.slice(0, bodyAt)}\n  ${trimmed}${stripped.slice(bodyAt)}`;

  const appAt = lastMatchStart(stripped, /<div\s+id=["']app["'][^>]*>/i);
  if (appAt >= 0) return `${stripped.slice(0, appAt)}${trimmed}\n  ${stripped.slice(appAt)}`;

  // No anchor to hang it on: a fragment that is not a document. Leaving it out
  // is the honest outcome — a cover pasted into the middle of markup is a
  // corrupt file, and this block is decoration.
  return stripped;
}

/** End offset of the last match, so the splice lands AFTER the tag. */
function lastMatchEnd(html: string, re: RegExp): number {
  const scan = new RegExp(re.source, "gi");
  let end = -1;
  for (let m = scan.exec(html); m; m = scan.exec(html)) end = m.index + m[0].length;
  return end;
}

/** Start offset of the last match, so the splice lands BEFORE it. */
function lastMatchStart(html: string, re: RegExp): number {
  const scan = new RegExp(re.source, "gi");
  let start = -1;
  for (let m = scan.exec(html); m; m = scan.exec(html)) start = m.index;
  return start;
}

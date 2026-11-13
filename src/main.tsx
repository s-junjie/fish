import "./style.css";
import { render, type ComponentType } from "preact";
import { capturePristine, registerPreviewGenerator } from "./core/data-bridge";
import { removeCoverFromDom } from "./core/cover-block";
import { installHostBridge } from "./core/plugins/host-bridge";
import { readOnlyFromShell } from "./core/persistence/file-policy";
import { APP_VERSION } from "./core/version";
import { renderThumbnailPreviewHtml } from "./ui/thumbnail-preview";
import { currentViewMode } from "./ui/viewer/viewer-mode";
import { CanvasOnlyRoot } from "./ui/canvas/CanvasOnlyRoot";
import { ViewerRoot } from "./ui/viewer/ViewerRoot";
import { EditorRoot } from "./ui/EditorRoot";

registerPreviewGenerator(renderThumbnailPreviewHtml);
// The file's own cover is a picture of the document, not part of the editor: it is
// cleared before the shell is captured, so a re-save writes a fresh one rather than
// inheriting the copy this session booted with.
removeCoverFromDom();
capturePristine();
// Before anything can open a panel: a plugin bundle reads the runtime off this
// global at module evaluation, and has no other way to reach Preact.
installHostBridge();
console.info(`FISH runtime v${APP_VERSION}`);

/**
 * The entry: decide the shell, then mount it.
 *
 * The three shells mount different hook trees — which is the whole reason a
 * read-only file never starts an auto-save, a gesture layer or a shortcut table
 * — so the mode is answered before any hook exists. `readOnly` is read once,
 * with the shell it came in: the policy is a property of the file, and nothing
 * this session does changes what the file said.
 */
const readOnly = readOnlyFromShell();
const mode = currentViewMode(readOnly);
const Root: ComponentType<{ readOnly: boolean }> =
  mode === "canvas" ? CanvasOnlyRoot : mode === "viewer" ? ViewerRoot : EditorRoot;

render(<Root readOnly={readOnly} />, document.getElementById("app")!);

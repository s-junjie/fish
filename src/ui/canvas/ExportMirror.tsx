import { DesignDocument, getActivePage } from "../../core/dsl/types";
import { flattenElements } from "../../core/geometry/tree-ops";
import { buildOnPathGuides } from "../../core/geometry/on-path";
import { CanvasDefs } from "./CanvasDefs";
import { SvgElementRenderer } from "./SvgElementRenderer";

const NO_IDS: Set<string> = new Set();
const NO_INPUT_REF = { current: null as HTMLTextAreaElement | null };
const noop = () => {};

/**
 * A read-only canvas with viewport culling switched off.
 *
 * The editing canvas only builds the elements near what is on screen, so an
 * export taken from it photographs the part being looked at — at the correct
 * size and with nothing to indicate that anything is missing, which is the worst
 * way an export can fail. This mounts the same two components `?view=canvas`
 * does, with the one difference that matters: `viewportBox` is null, so the whole
 * page is built.
 *
 * Nothing here is measured or laid out for display. The exporter clones this
 * markup and reads attributes off it, so a one-pixel, off-screen box is enough
 * and the tree costs no paint.
 */
export function ExportMirror({
  doc,
  docRef,
  hostRef
}: {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  hostRef: { current: HTMLDivElement | null };
}) {
  const activePage = getActivePage(doc);
  // Same guides as the visible canvas, so an exported file places a text-on-path
  // run on the side the document asked for rather than the side the renderer
  // defaulted to.
  const onPathGuides = buildOnPathGuides(flattenElements(activePage.children));
  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: "-100000px",
        top: "0",
        width: "1px",
        height: "1px",
        overflow: "hidden",
        pointerEvents: "none"
      }}
    >
      <svg width="1" height="1" style={{ display: "block" }}>
        <CanvasDefs
          allElements={flattenElements(activePage.children)}
          viewportBox={null}
          selectedIds={NO_IDS}
          assets={doc.assets}
          docRef={docRef}
          onPathGuides={onPathGuides}
        />
        <SvgElementRenderer
          onPathGuides={onPathGuides}
          elements={activePage.children}
          selectedIds={NO_IDS}
          setSelectedIds={noop}
          docRef={docRef}
          zoom={1}
          activeTool="select"
          viewportBox={null}
          dragOverFrameId={null}
          editingCanvasTextId={null}
          canvasTextDraft=""
          setCanvasTextDraft={noop}
          canvasTextInputRef={NO_INPUT_REF}
          onElementMouseDown={noop}
          onStartCanvasTextEdit={noop}
          onCommitCanvasText={noop}
          onCancelCanvasText={noop}
          editingPathId={null}
        />
      </svg>
    </div>
  );
}

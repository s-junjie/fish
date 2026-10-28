import { DesignDocument, DesignElement } from "../../core/dsl/types";
import { CanvasArea } from "./CanvasArea";

interface CanvasOnlyViewProps {
  canvasContainerRef: { current: HTMLDivElement | null };
  headlessOrigin: { x: number; y: number } | null;
  doc: DesignDocument;
  allElements: DesignElement[];
  docRef: { current: DesignDocument };
  canvasTextInputRef: { current: HTMLTextAreaElement | null };
}

/**
 * `?view=canvas`: the bare document, for a screenshot or an embed that wants the
 * artwork and nothing else.
 *
 * Every editing prop is absent rather than wired to a no-op, and that is the
 * point: `CanvasArea` reads each one to decide whether to attach a listener, so
 * an inert handler would leave a dozen gesture handlers bound to a canvas that
 * is meant to be still. The one exception is the text input ref, which the
 * canvas needs in order to be measurable rather than interactive.
 */
export function CanvasOnlyView({
  canvasContainerRef,
  headlessOrigin,
  doc,
  allElements,
  docRef,
  canvasTextInputRef
}: CanvasOnlyViewProps) {
  return (
    <div className="w-screen h-screen overflow-hidden bg-panel select-none">
      <CanvasArea
        canvasContainerRef={canvasContainerRef}
        isCanvasOnlyView={true}
        headlessOrigin={headlessOrigin}
        doc={doc}
        allElements={allElements}
        docRef={docRef}
        zoom={1}
        pan={{ x: 0, y: 0 }}
        isCanvasPanning={false}
        isPanMode={false}
        activeTool="select"
        selectedIds={new Set()}
        setSelectedIds={() => {}}
        selectedElements={[]}
        primarySelected={null}
        multiBounds={null}
        activeGuides={[]}
        marqueeRect={null}
        dragOverFrameId={null}
        hoverSelectId={null}
        editingCanvasTextId={null}
        canvasTextDraft=""
        setCanvasTextDraft={() => {}}
        canvasTextInputRef={canvasTextInputRef}
        onCanvasMouseDown={() => {}}
        onCanvasMouseMove={() => {}}
        onWheel={() => {}}
        onCanvasClick={() => {}}
        onElementMouseDown={() => {}}
        onResizePointerDown={() => {}}
        onRotatePointerDown={() => {}}
        onEndpointPointerDown={() => {}}
        onRadiusPointerDown={() => {}}
        onStartCanvasTextEdit={() => {}}
        onCommitCanvasText={() => {}}
        onCancelCanvasText={() => {}}
        onOnPathTextBounds={() => {}}
        onStartOffsetPointerDown={() => {}}
        onGradientHandlePointerDown={() => {}}
      />
    </div>
  );
}

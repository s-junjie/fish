import type { AutoLayout, DesignDocument, FrameElement } from "../../core/dsl/types";
import { SegmentedControl } from "../SegmentedControl";
import { Columns3, LayoutGrid, Rows3, Ungroup } from "lucide-react";
import { t } from "../../i18n";
import { PadMode, PadTuple } from "./pad-fields";
import { layoutOf } from "../../core/dsl/layout-flat";
import type { LayoutMode } from "./layout-controls-shared";
import { FlexLayoutControls, type FlexLayoutControlsProps } from "./flex-layout-controls";
import { GridLayoutControls, type GridLayoutControlsProps } from "./grid-layout-controls";

export type { FlexLayoutControlsProps, GridLayoutControlsProps };
export type { LayoutMode, PadMode, PadTuple };

/** The mode switch, and the padding-mode segment both flex and grid reuse. */
export function LayoutModeSegmented({
  value,
  onChange
}: {
  value: LayoutMode;
  onChange: (m: LayoutMode) => void;
}) {
  return (
    <SegmentedControl<LayoutMode>
      className="w-full"
      value={value}
      onChange={onChange}
      items={[
        { value: "free", icon: <Ungroup size={13} />, title: t("stack.modeFree"), grow: true },
        { value: "vertical", icon: <Rows3 size={13} />, title: t("stack.modeVertical"), grow: true },
        { value: "horizontal", icon: <Columns3 size={13} />, title: t("stack.modeHorizontal"), grow: true },
        { value: "grid", icon: <LayoutGrid size={13} />, title: t("stack.modeGrid"), grow: true }
      ]}
    />
  );
}

export interface AutoLayoutControlsProps {
  frame: FrameElement;
  doc?: DesignDocument;
  docRef?: { current: DesignDocument };
  layoutMode: LayoutMode;
  switchLayoutMode: (m: LayoutMode) => void;
  pad: PadTuple;
  padMode: PadMode;
  setPaddingMode: (m: PadMode) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onLayout: (
    patch: Partial<AutoLayout>,
    commit?: boolean,
    tokenBindingsPatch?: Record<string, string | undefined>
  ) => void;
  /** The undo stream for a token edit saved from the gap/pad token pickers. */
  onCommitSnapshot?: (newDoc: DesignDocument) => void;
}

/** Both layout modes, one component, so the panel reads as a mode switch. */
export function AutoLayoutControls(props: AutoLayoutControlsProps) {
  const { frame, layoutMode } = props;
  const layout = layoutOf(frame);
  return (
    <>
      <LayoutModeSegmented value={layoutMode} onChange={props.switchLayoutMode} />

      {layout?.mode === "flex" && (
        <FlexLayoutControls
          frame={frame}
          doc={props.doc}
          docRef={props.docRef}
          pad={props.pad}
          padMode={props.padMode}
          setPaddingMode={props.setPaddingMode}
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          onLayout={props.onLayout}
          onCommitSnapshot={props.onCommitSnapshot}
        />
      )}

      {layout?.mode === "grid" && (
        <GridLayoutControls
          frame={frame}
          pad={props.pad}
          padMode={props.padMode}
          setPaddingMode={props.setPaddingMode}
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          onLayout={props.onLayout}
        />
      )}
    </>
  );
}

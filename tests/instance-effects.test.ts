import { describe, it, expect } from "vitest";
import { InstanceNode, InstanceNodeProps } from "../src/ui/canvas/InstanceNode";
import { SvgNodeRenderer } from "../src/ui/canvas/SvgElementRenderer";
import { resolveInstanceBox } from "../src/core/interactions/instance-inherit";
import { ComponentElement, DesignDocument, Effect, InstanceElement } from "../src/core/dsl/types";

/**
 * An instance painted its box and its master's children and stopped there. The
 * `<filter>` for its effects was still emitted by CanvasDefs — from the same
 * resolved list — so the shadow was defined, referenced by nothing, and a
 * component with an elevation painted flat the moment it was instantiated.
 *
 * `InstanceNode` is a plain function over props, so the attribute is asserted
 * here rather than through a browser: the failure mode was a missing reference,
 * not a wrong number.
 */
const SHADOW: Effect[] = [
  { type: "drop-shadow", color: "rgba(0,0,0,0.26)", offset: { x: 0, y: 44 }, blur: 90, enabled: true } as Effect
];

const master: ComponentElement = {
  id: "cmp/card",
  type: "component",
  name: "Card",
  x: 0,
  y: 0,
  width: 120,
  height: 80,
  borderRadius: 22,
  fills: [{ type: "solid", color: "#FFFFFF" }],
  effects: SHADOW,
  children: []
};

const instance = (extra: Partial<InstanceElement> = {}): InstanceElement => ({
  id: "inst",
  type: "instance",
  componentId: master.id,
  x: 200,
  y: 40,
  width: 120,
  height: 80,
  ...extra
});

const render = (inst: InstanceElement, m: ComponentElement = master) => {
  const props: InstanceNodeProps = {
    el: inst,
    master: m,
    box: resolveInstanceBox(inst, m),
    isSelected: false,
    isMaskStencil: false,
    ctx: {
      docRef: { current: { version: "0.1", canvas: { width: 10, height: 10, unit: "px", background: { type: "solid", color: "#000" } } } as DesignDocument },
      zoom: 1,
      onElementMouseDown: () => {}
    } as any,
    onDoubleClick: () => {},
    renderChildren: () => []
  };
  return InstanceNode(props) as any;
};

const filterRef = (vnode: any): string | undefined => vnode?.props?.filter;

describe("an instance paints the effects it resolved", () => {
  it("references the shadow filter its master carries", () => {
    expect(filterRef(render(instance()))).toBe("url(#filter_inst)");
  });

  it("references its own shadow, not only an inherited one", () => {
    expect(filterRef(render(instance({ effects: SHADOW })))).toBe("url(#filter_inst)");
  });

  it("stays flat when the master has no effects", () => {
    expect(filterRef(render(instance(), { ...master, effects: undefined }))).toBeUndefined();
  });

  it("honours effects: [] as 'suppress my master's', per the inheritance rule", () => {
    // Presence, not truthiness: an explicit empty stack is an answer, and this
    // is the gesture that suppresses a component's shadow.
    expect(filterRef(render(instance({ effects: [] })))).toBeUndefined();
  });

  it("omits the reference for a disabled effect", () => {
    const off: Effect[] = [{ ...SHADOW[0], enabled: false } as Effect];
    expect(filterRef(render(instance({ effects: off })))).toBeUndefined();
  });

  it("references the colour filter it declares", () => {
    const vnode = render(instance({ adjust: { brightness: 1.2 } } as Partial<InstanceElement>));
    expect(filterRef(vnode)).toBe("url(#filter_inst)");
  });
});

/**
 * The node that renders an instance applies the same `filter_<id>` that
 * `InstanceNode` puts on its own group. Both chains ran, so a component's shadow
 * was composited over an already-shadowed result and every instance of a
 * component with elevation read about twice as dark as the master — and as the
 * same box detached into a frame, which is what made the detached copy look
 * correct and the instance look wrong.
 *
 * Asserted on the rendered wrapper rather than in a browser: the failure is a
 * duplicated attribute reference, and it is deterministic.
 */
describe("an instance's effects are applied once, by InstanceNode", () => {
  const doc = {
    version: "0.1",
    id: "doc_1",
    name: "Doc",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canvas: { width: 400, height: 400, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
    pages: [],
    activePageId: "p1",
    elements: [master]
  } as unknown as DesignDocument;

  const renderNode = (el: any) =>
    SvgNodeRenderer({
      el,
      isSelected: false,
      isDragOver: false,
      isEditingText: false,
      isEditingPath: false,
      isMaskStencil: false,
      ctx: {
        selectedIds: new Set<string>(),
        setSelectedIds: () => {},
        docRef: { current: doc },
        zoom: 1,
        activeTool: "select",
        dragOverFrameId: null,
        editingCanvasTextId: null,
        canvasTextDraft: "",
        canvasTextInputRef: { current: null },
        onElementMouseDown: () => {},
        onStartCanvasTextEdit: () => {},
        onCommitCanvasText: () => {},
        onCancelCanvasText: () => {}
      } as any
    }) as any;

  it("leaves the filter off the wrapper for an instance", () => {
    expect(renderNode(instance()).props.filter).toBeUndefined();
  });

  it("still lets the wrapper filter a plain element", () => {
    expect(renderNode(master).props.filter).toBe("url(#filter_cmp/card)");
  });
});

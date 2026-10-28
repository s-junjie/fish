import { describe, it, expect } from "vitest";
import { SvgTextNode } from "../src/ui/canvas/SvgTextNode";
import type { NodeRenderContext } from "../src/ui/canvas/NodeRenderContext";
import type { Paint, TextElement } from "../src/core/dsl/types";

/**
 * What the canvas paints a text with.
 *
 * `SvgTextNode` is a plain function with no hooks, so calling it and reading the
 * vnode it returns is the cheapest honest check on the emitted attributes — and
 * the attributes are the whole question. A text's ink is its `fills` stack:
 * `style.color` is the field an author WRITES a colour in, not a second store,
 * and reading it as a fallback put black glyphs back on a text whose stack said
 * `[]` (LESSONS_LEARNED §206).
 */

const ctx = (): NodeRenderContext =>
  ({
    canvasTextInputRef: { current: null },
    canvasTextDraft: "",
    setCanvasTextDraft: () => {},
    onCommitCanvasText: () => {},
    onCancelCanvasText: () => {},
    onElementMouseDown: () => {},
    onPathGuides: new Map()
  }) as unknown as NodeRenderContext;

const textEl = (extra: Partial<TextElement> = {}): TextElement =>
  ({
    id: "t1",
    type: "text",
    name: "t1",
    x: 0,
    y: 0,
    width: 200,
    height: 40,
    content: "hello",
    style: { fontFamily: "Inter", fontSize: 16, color: "#000000" },
    ...extra
  }) as TextElement;

function box(el: TextElement, activeFills: Paint[]) {
  return SvgTextNode({
    el,
    isEditingText: false,
    activeFills,
    activeStrokes: [],
    fillLayerIndex: () => 0,
    strokeLayerIndex: () => 0,
    ctx: ctx()
  }) as any;
}

describe("a text's ink is its fill stack", () => {
  it("paints nothing when the stack is empty, whatever style.color says", () => {
    const node = box(textEl({ fills: [] }), []);

    expect(node.props["data-text-fill"]).toBe("none");
    const inner = node.props.children.props.children;
    expect(inner.props.textFill).toBe("transparent");
  });

  it("paints the top layer's colour", () => {
    const node = box(textEl({ fills: [{ type: "solid", color: "#FF0000" }] }), [
      { type: "solid", color: "#FF0000" }
    ]);

    expect(node.props["data-text-fill"]).toBe("#FF0000");
    expect(node.props.children.props.children.props.textFill).toBe("#FF0000");
  });

  /**
   * The caret is an AFFORDANCE, not paint: a text with no ink is still a text
   * the author can double-click into, so the cursor has to stay visible.
   */
  it("keeps the caret visible on a text with no ink", () => {
    const node = box(textEl({ fills: [] }), []);
    const caret = node.props.children.props.children.props.caretColor;

    expect(caret).toBeTruthy();
    expect(caret).not.toBe("transparent");
  });

  it("draws on-path text with fill=none rather than defaulting to black", () => {
    const node = box(textEl({ fills: [], onPath: { pathId: "p1" } }), []) as any;
    const onPathText = node.props.children[0];

    expect(onPathText.props.fill).toBe("none");
  });
});

import { describe, it, expect } from "vitest";
import { SvgTextNode } from "../src/ui/canvas/SvgTextNode";
import type { NodeRenderContext } from "../src/ui/canvas/NodeRenderContext";
import type { TextElement } from "../src/core/dsl/types";

/**
 * The one thing a `foreignObject`'s HTML must never do.
 *
 * WebKit stops honouring every ancestor `transform` for a `foreignObject`'s HTML
 * content as soon as ONE descendant establishes a containing block or a paint
 * layer — `position: relative`, a CSS `transform`, `will-change`, `isolation`,
 * `contain`. The text then paints at the SVG origin: in a real file that is the
 * frame's `translate` dropped, and a whole page of artwork lands on top of its
 * neighbour in Safari while Chromium looks right. Layout is unaffected
 * (`getBoundingClientRect` agrees), so nothing but a painted screenshot catches
 * it — which is why the rule is graded here, on the vnode.
 */
const ctx = () =>
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

const wrapperStyle = (extra: Partial<TextElement> = {}) => {
  const node = SvgTextNode({
    el: textEl(extra),
    isEditingText: false,
    activeFills: [{ type: "solid", color: "#000000" }],
    activeStrokes: [],
    fillLayerIndex: () => 0,
    strokeLayerIndex: () => 0,
    ctx: ctx()
  }) as any;
  const wrapper = node.props.children;
  return { node, style: wrapper.props.style as Record<string, unknown>, inner: wrapper.props.children };
};

const LAYER_KEYS = ["position", "transform", "willChange", "isolation", "contain"];

describe("foreignObject HTML never establishes a containing block", () => {
  it("leaves every layer-creating property unset on the text wrapper", () => {
    const { style } = wrapperStyle();

    for (const key of LAYER_KEYS) expect(style[key]).toBeUndefined();
  });

  it("moves tracked ink with a margin, not a translate", () => {
    const { style } = wrapperStyle({
      style: { fontFamily: "Inter", fontSize: 16, color: "#000000", align: "center", letterSpacing: 8 }
    });

    expect(style.transform).toBeUndefined();
    expect(style.marginLeft).toBe("4px");
  });

  it("adds no margin when nothing is tracked", () => {
    const { style } = wrapperStyle();

    expect(style.marginLeft).toBeUndefined();
  });
});

/**
 * `max-content` is the mode that promises "this box holds its longest line
 * unwrapped", so a paint that wraps has contradicted the width it was given.
 * Safari does exactly that on the sub-pixel — the demo's CTA label fitted its
 * box exactly and Safari broke it after "the", Chromium did not — so the mode is
 * stated in CSS as well as in the number.
 *
 * It has to be stated on the element that HOLDS the glyphs: the wrapper is not
 * enough, because the content element writes its own `white-space` and that
 * shorthand resets an inherited `text-wrap`.
 */
describe("a max-content text cannot soft-wrap", () => {
  it("asks the text element itself not to wrap", () => {
    const { inner } = wrapperStyle({ sizing: { width: "max-content", height: "fit-content" } });

    expect(inner.props.noSoftWrap).toBe(true);
  });

  it("leaves a fixed-width text wrapping", () => {
    const { inner } = wrapperStyle({ sizing: { width: "fixed", height: "fit-content" } });

    expect(inner.props.noSoftWrap).toBe(false);
  });
});

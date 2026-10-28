import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { h } from "preact";
import { maskAlphaFilterDef, maskBackdropClip, maskClipDef, maskIsClip, maskLayerDef, MaskDefOptions } from "../src/ui/canvas/mask-defs";
import { renderNodeList } from "../src/ui/canvas/SvgElementRenderer";
import type { NodeRenderContext } from "../src/ui/canvas/NodeRenderContext";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { documentJson } from "../src/core/document-json";
import { normalizeMaskMode } from "../src/core/dsl/normalize/element";
import { MASK_MODES } from "../src/core/dsl/schema-enums";
import { maskChannelVaries } from "../src/core/dsl/paint-stack";
import schema from "../src/core/dsl/fish.schema.json";
import versions from "../src/core/dsl/versions.json";
import type { DesignElement, Paint, PaintStack } from "../src/core/dsl/types";
import type { InstanceBox } from "../src/core/interactions/instance-inherit";

/**
 * `isMask` used to paint a hardcoded `#FFFFFF` stencil of the element's outline
 * and discard every fill, so an image-filled mask revealed 100% of the siblings
 * behind it and the feature simply did not exist. The mask is the element's own
 * paint now, which is what makes an image a mask.
 *
 * These are plain functions over an element, so the emitted attributes are
 * asserted directly rather than through a browser.
 */
const rect = (extra: Partial<DesignElement> = {}): DesignElement =>
  ({
    id: "m",
    type: "rect",
    x: 10,
    y: 20,
    width: 200,
    height: 150,
    isMask: true,
    ...extra
  }) as DesignElement;

const render = (el: DesignElement, over: Partial<MaskDefOptions> = {}): any =>
  maskLayerDef(el, { box: null, fills: el.fills ?? [], ...over });

/** Every element VNode in a tree, in document order. */
const elementsIn = (vnode: any, out: any[] = []): any[] => {
  if (vnode == null || typeof vnode !== "object") return out;
  if (typeof vnode.type === "string") out.push(vnode);
  const children = vnode.props?.children;
  for (const c of Array.isArray(children) ? children : [children]) elementsIn(c, out);
  return out;
};

const byTag = (vnode: any, tag: string): any[] => elementsIn(vnode).filter((v) => v.type === tag);
/** The group the filter and the layer's opacity ride — the outermost one. */
const group = (mask: any): any => byTag(mask, "g")[0];
/** The group carrying the layer's own translate, one level inside that. */
const stencil = (mask: any): any => byTag(mask, "g").find((g) => g.props.transform);
const painted = (mask: any): any[] => byTag(mask, "path");

describe("a mask paints the element's own fill stack", () => {
  it("paints an image fill by referencing that layer's pattern", () => {
    // `pat_<elementId>_<layerIndex>` is the id CanvasDefs gives the image
    // pattern, so this reference is the whole feature: the mask is the photo.
    expect(painted(render(rect({ fills: [{ type: "image", assetId: "a1" }] })))[0].props.fill).toBe(
      "url(#pat_m_0)"
    );
  });

  it("indexes an image layer by its position in the stack, not by the visible one", () => {
    // Layer 0 is a disabled solid and layer 1 the image. Looking the image up by
    // its filtered position would point at `pat_m_0`, which is never emitted.
    const fills: PaintStack = [
      { type: "solid", color: "#FF0000", enabled: false },
      { type: "image", assetId: "a1" }
    ];
    const mask = render(rect({ fills }));

    expect(painted(mask)).toHaveLength(1);
    expect(painted(mask)[0].props.fill).toBe("url(#pat_m_1)");
  });

  it("references a gradient layer's own gradient def", () => {
    const mask = render(rect({ fills: [{ type: "linear-gradient", stops: [] } as any] }));

    expect(painted(mask)[0].props.fill).toBe("url(#grad_fill_m_0)");
  });

  it("carries a fill layer's own opacity into the mask", () => {
    const mask = render(rect({ fills: [{ type: "image", assetId: "a1", opacity: 0.25 }] }));

    expect(painted(mask)[0].props.fillOpacity).toBe(0.25);
  });

  it("scales the whole mask by the element's own opacity", () => {
    expect(group(render(rect({ opacity: 0.5, fills: [{ type: "solid", color: "#FFFFFF" }] }))).props.opacity).toBe(0.5);
  });

  it("places the mask content at the element's own origin and rotation", () => {
    const mask = render(rect({ rotation: 30, fills: [{ type: "solid", color: "#FFFFFF" }] }));

    expect(stencil(mask).props.transform).toBe("translate(10, 20) rotate(30 100 75)");
  });

  it("falls back to the outline when nothing is painted", () => {
    const mask = render(rect());

    expect(painted(mask)).toHaveLength(1);
    expect(painted(mask)[0].props.fill).toBe("#FFFFFF");
  });

  it("masks by an instance's resolved box rather than an empty path", () => {
    // `getShapeLocalPath` returns "" for an instance, and an empty path is a
    // fully transparent mask — the siblings behind it vanished.
    const el = rect({ type: "instance" } as Partial<DesignElement>);
    const box = { width: 120, height: 80, borderRadius: 16 } as InstanceBox;

    expect(painted(render(el, { box, fills: [{ type: "solid", color: "#FFFFFF" }] }))[0].props.d).toBeTruthy();
    expect(painted(render(el, { fills: [{ type: "solid", color: "#FFFFFF" }] }))[0].props.d).toBeFalsy();
  });
});

/**
 * A container mask paints nothing of its own, so what it draws IS its children —
 * which is the Figma idiom behind a tinted icon or gradient text: a fill-less
 * frame holding the glyphs, with the tint rectangle underneath it clipped to
 * those glyphs.
 *
 * The outline fallback below used to be the whole answer for a fill-less layer,
 * which made that frame mask as a solid 68×41 rectangle sitting ON TOP of the
 * glyphs — the block of blue an iOS tab bar used to import as.
 */
describe("a fill-less container masks by its contents", () => {
  const frame = (extra: Partial<DesignElement> = {}): DesignElement =>
    rect({ type: "frame", x: 0, y: 0, width: 68, height: 41, fills: [], children: [], ...extra } as Partial<DesignElement>);

  const glyph = (extra: Partial<DesignElement> = {}): DesignElement =>
    ({
      id: "g1",
      type: "rect",
      x: 4,
      y: 6,
      width: 20,
      height: 12,
      fills: [{ type: "solid", color: "#FF0000" }]
    }) as unknown as DesignElement;

  const word = (extra: Partial<DesignElement> = {}): DesignElement =>
    ({
      id: "w1",
      type: "text",
      x: 4,
      y: 22,
      width: 40,
      height: 10,
      content: "Aa",
      style: { color: "#FFFFFF", fontSize: 10 },
      fills: [{ type: "solid", color: "#FFFFFF" }],
      outline: { d: "M0 0 H40 V10 H0 Z" }
    }) as unknown as DesignElement;

  it("masks by each child's shape rather than by the frame's box", () => {
    const mask = render(frame({ children: [glyph()] } as Partial<DesignElement>));

    const paths = painted(mask);
    expect(paths).toHaveLength(1);
    // One matrix per leaf rather than nested `<g>`s: a `<clipPath>` cannot hold
    // a `<g>` at all, and both defs read the same walk.
    expect(paths[0].props.transform).toBe("matrix(1 0 0 1 4 6)");
    expect(paths[0].props.fill).toBe("#FFFFFF");
  });

  it("carries a text's own outline, which is the only thing that can mask words", () => {
    // A text node paints through a `foreignObject`, and a mask renders neither
    // — so without `outline` the frame has nothing to mask by and falls back to
    // its box. The outline is Figma's own measured glyph path, so it needs no
    // font and cannot drift from the design.
    const mask = render(frame({ children: [word()] } as Partial<DesignElement>));

    expect(painted(mask)[0].props.d).toBe("M0 0 H40 V10 H0 Z");
    expect(painted(mask)[0].props.transform).toBe("matrix(1 0 0 1 4 22)");
  });

  it("composes a nested container's transform into its children", () => {
    const inner = frame({ id: "inner", x: 6, y: 2, children: [glyph()] } as Partial<DesignElement>);
    const mask = render(frame({ children: [inner] } as Partial<DesignElement>));

    expect(painted(mask)[0].props.transform).toBe("matrix(1 0 0 1 10 8)");
    expect(painted(mask)).toHaveLength(1);
  });

  it("turns a rotated child about its own centre, not its absolute pivot", () => {
    // `translate(x, y) rotate(r, cx, cy)` composed with the ABSOLUTE pivot —
    // which is what this used to be — displaces the shape by its own `x`/`y`
    // around the rotation. Measured: the mask of a 45°-rotated glyph came out
    // as a diamond sitting up and to the right of the artwork it masked.
    const spun = { ...glyph(), rotation: 45 } as unknown as DesignElement;
    const mask = render(frame({ children: [spun] } as Partial<DesignElement>));

    const [a, b, c, d, e, f] = (painted(mask)[0].props.transform as string).slice(7, -1).split(" ").map(Number);
    // The glyph's own centre is a fixed point of the mask's transform: (4+10, 6+6).
    expect(a * 10 + c * 6 + e).toBeCloseTo(14, 2);
    expect(b * 10 + d * 6 + f).toBeCloseTo(12, 2);
  });

  it("still masks by its outline when nothing in it can be drawn", () => {
    // A childless fill-less layer is the documented outline, and so is one whose
    // contents cannot be a shape. An EMPTY mask would hide the layer beneath it,
    // which is worse than the box it replaced.
    expect(painted(render(frame()))).toHaveLength(1);
    expect(painted(render(rect()))[0].props.fill).toBe("#FFFFFF");
    const noOutline = { ...word(), outline: undefined } as DesignElement;
    expect(painted(render(frame({ children: [noOutline] } as Partial<DesignElement>)))).toHaveLength(1);
  });

  it("refuses an html or video child rather than masking nothing", () => {
    for (const type of ["html", "video"] as const) {
      const child = { id: "h1", type, x: 0, y: 0, width: 10, height: 10 } as unknown as DesignElement;
      expect(painted(render(frame({ children: [child] } as Partial<DesignElement>)))).toHaveLength(1);
    }
  });

  it("keeps a container that paints its own fill masked by that fill", () => {
    // Its contents are already covered by its own box wherever the fill is
    // opaque, which is the only way Figma uses one too; changing that would
    // change every filled mask for no measurable gain.
    const mask = render(frame({ fills: [{ type: "solid", color: "#EEEEEE" }], children: [glyph()] } as Partial<DesignElement>));

    expect(painted(mask).map((p) => p.props.fill)).toEqual(["#EEEEEE"]);
  });

  it("carries the contents through the same alpha adapter as any other mask", () => {
    // Without the adapter a black glyph in luminance mode would read as fully
    // hidden, and `<mask>` is luminance-based whatever `maskMode` says.
    expect(group(render(frame({ children: [glyph()] } as Partial<DesignElement>))).props.filter).toBe(
      "url(#maskalpha_m)"
    );
  });
});

describe("maskMode chooses the channel", () => {
  const imageEl = (extra: Partial<DesignElement> = {}) =>
    rect({ fills: [{ type: "image", assetId: "a1" }], ...extra });

  it("normalizes alpha mode's content to white so the alpha survives", () => {
    // SVG's `<mask>` is luminance-based. Painting the image directly would make
    // a black pixel read as fully hidden, so alpha mode routes the content
    // through a filter that writes white into RGB and leaves alpha alone.
    expect(group(render(imageEl())).props.filter).toBe("url(#maskalpha_m)");

    const filter = maskAlphaFilterDef(imageEl()) as any;
    expect(filter.props.id).toBe("maskalpha_m");
    // The last five numbers are the alpha row: pass alpha through untouched.
    const values = String(filter.props.children.props.values).trim().split(/\s+/);
    expect(values).toHaveLength(20);
    expect(values.slice(15).join(" ")).toBe("0 0 0 1 0");
  });

  it("leaves luminance mode unfiltered, because brightness IS the mask", () => {
    const el = imageEl({ maskMode: "luminance" });

    expect(group(render(el)).props.filter).toBeUndefined();
    expect(maskAlphaFilterDef(el)).toBeNull();
  });

  it("gives the adapter the same region as the mask it serves", () => {
    const mask = render(imageEl());
    const filter = maskAlphaFilterDef(imageEl()) as any;

    // A bbox-relative filter region collapses to nothing for a zero-area shape,
    // which would make such a mask hide everything.
    for (const axis of ["x", "y", "width", "height"]) {
      expect(filter.props[axis]).toBe(mask.props[axis]);
    }
    expect(filter.props.filterUnits).toBe("userSpaceOnUse");
  });

  it("defaults to alpha when the document says nothing", () => {
    const el = imageEl();
    expect(el.maskMode).toBeUndefined();

    expect(group(render(el)).props.filter).toBe("url(#maskalpha_m)");
  });

  it("paints a text mask in the text's own colour, not a white stencil", () => {
    // Luminance mode reads this colour, so a hardcoded white would make every
    // text mask identical whatever the text was painted.
    const el = rect({
      type: "text",
      content: "Aa",
      style: { color: "#FF0000" },
      fills: [{ type: "solid", color: "#FF0000" }]
    } as Partial<DesignElement>);

    expect(byTag(render(el), "text")[0].props.fill).toBe("#FF0000");
  });
});

describe("the renderer references the mask, and CanvasDefs is where it is built", () => {
  // The body is painted from the element's own geometry, so the def needs no
  // render context and stays in `<defs>` — which is also what keeps it emitted
  // for a mask inside an instance's resolved content, where no element list of
  // this call reaches.
  const ctx = () =>
    ({
      selectedIds: new Set<string>(),
      docRef: { current: { version: "0.1", pages: [] } as never },
      zoom: 1,
      rasterScale: 1,
      activeTool: "select",
      worldBounds: new Map(),
      dragOverFrameId: null,
      editingCanvasTextId: null,
      canvasTextDraft: "",
      setCanvasTextDraft: () => {},
      canvasTextInputRef: { current: null },
      onElementMouseDown: () => {},
      onStartCanvasTextEdit: () => {},
      onCommitCanvasText: () => {},
      onCancelCanvasText: () => {}
    }) as unknown as NodeRenderContext;

  const maskFrame = {
    id: "m",
    type: "frame",
    x: 0,
    y: 0,
    width: 68,
    height: 41,
    isMask: true,
    children: [
      { id: "glyph", type: "rect", x: 4, y: 4, width: 20, height: 20, fills: [{ type: "solid", color: "#FF0000" }] }
    ]
  } as unknown as DesignElement;

  const tint = {
    id: "t",
    type: "rect",
    x: 0,
    y: 0,
    width: 93,
    height: 54,
    fills: [{ type: "solid", color: "#0088FF" }]
  } as unknown as DesignElement;

  it("wraps the following siblings in one group carrying the mask reference", () => {
    const painted = renderNodeList([maskFrame, tint], ctx(), false).flatMap((g) => elementsIn(g));
    // The frame is fill-less, so its mask is pure geometry and goes out as a
    // CLIP: a `<mask>` ancestor is a backdrop root, and a backdrop blur under
    // one paints nothing at all.
    const masked = painted.filter((v) => v.props?.clipPath === "url(#clip_mask_m)");

    expect(masked).toHaveLength(1);
    // The def itself is not here — it lives in CanvasDefs — so this list carries
    // the reference and nothing that would shadow it with a second copy.
    expect(painted.filter((v) => v.type === "mask")).toHaveLength(0);
  });
});

describe("a mask that is pure geometry is stated as a clip", () => {
  // Chromium makes any element carrying a mask a backdrop root, so a
  // `backdrop-filter` inside one samples an empty backdrop and paints nothing:
  // a frosted panel lost its blur the moment a mask layer covered it. A
  // `clip-path` is not a backdrop root, so a mask whose coverage is 0 or 1
  // everywhere can be restated as one and the backdrop survives.
  //
  // What is left as a `<mask>`: a gradient or a photo (soft coverage a clip
  // cannot state), a translucent fill, and a text with no outline. Those keep
  // today's behaviour — their blur stays lost — because the one alternative,
  // a CSS `mask-image` on the backdrop div, is inert inside the canvas tree
  // (measured, `scratch/dbg-half-mask3.mjs`).
  const leaf = (extra: Partial<DesignElement> = {}): DesignElement =>
    rect({ isMask: true, fills: [{ type: "solid", color: "#000000" }], ...extra });

  it("accepts an opaque solid shape, whatever its colour", () => {
    // Alpha mode normalizes the content to white with its alpha intact, so a
    // black fill is as opaque as a white one — coverage is all that is left.
    expect(maskIsClip(leaf())).toBe(true);
    expect(maskIsClip(leaf({ fills: [{ type: "solid", color: "#FFFFFF" }] }))).toBe(true);
  });

  it("refuses anything whose coverage is not 0 or 1", () => {
    const of = (el: DesignElement) => maskIsClip(el);

    expect(of(leaf({ fills: [{ type: "solid", color: "#000000", opacity: 0.5 }] }))).toBe(false);
    expect(of(leaf({ fills: [{ type: "image", assetId: "a1" }] }))).toBe(false);
    expect(of(leaf({ fills: [{ type: "linear-gradient", stops: [] } as any] }))).toBe(false);
    expect(of(leaf({ opacity: 0.5 }))).toBe(false);
    expect(of(leaf({ type: "text", content: "Aa", style: { color: "#000000" } } as Partial<DesignElement>))).toBe(false);
    expect(of(leaf({ type: "instance" } as Partial<DesignElement>))).toBe(false);
  });

  it("refuses a luminance mask that is not white, whose brightness IS the coverage", () => {
    const grey = leaf({ maskMode: "luminance", fills: [{ type: "solid", color: "#808080" }] });

    expect(maskIsClip(grey)).toBe(false);
    const white = leaf({ maskMode: "luminance", fills: [{ type: "solid", color: "#FFFFFF" }] });
    expect(maskIsClip(white)).toBe(true);
  });

  it("accepts a fill-less container, which masks by its contents", () => {
    const frame = leaf({ type: "frame", fills: [], children: [{ id: "g", type: "rect", x: 4, y: 6, width: 20, height: 12, fills: [{ type: "solid", color: "#FF0000" }] }] } as Partial<DesignElement>);

    expect(maskIsClip(frame)).toBe(true);
  });

  it("emits the shapes into a clipPath, with no mask and no alpha adapter", () => {
    const el = leaf({ fills: [{ type: "solid", color: "#000000" }] });
    const clip = maskClipDef(el) as any;

    expect(clip.type).toBe("clipPath");
    expect(clip.props.id).toBe("clip_mask_m");
    expect(clip.props.clipPathUnits).toBe("userSpaceOnUse");
    expect(maskAlphaFilterDef(el)).not.toBeNull();
  });

  it("returns null for a mask it cannot state, so the caller keeps the `<mask>`", () => {
    const el = leaf({ fills: [{ type: "image", assetId: "a1" }] });

    expect(maskClipDef(el)).toBeNull();
  });

  it("carries the element's own rotation and position into the clip", () => {
    const el = leaf({ rotation: 30, fills: [{ type: "solid", color: "#FFFFFF" }] });
    const clip = maskClipDef(el) as any;
    const t = (byTag(clip, "path")[0].props.transform as string).slice(7, -1).split(" ").map(Number);

    // The box centre (10+100, 20+75) is a fixed point, as it is for the artwork.
    expect(t[0] * 100 + t[2] * 75 + t[4]).toBeCloseTo(110, 2);
    expect(t[1] * 100 + t[3] * 75 + t[5]).toBeCloseTo(95, 2);
  });
});

describe("maskInvert reads the luminance as its negative", () => {
  // Only `luminance` has a channel worth turning over: a mask read backwards is
  // a photographic negative. Inverting ALPHA would reveal everything the layer
  // does NOT paint — a region, not a shape — so the flag is read in luminance
  // mode alone.
  const inverted = (extra: Partial<DesignElement> = {}) =>
    rect({ maskInvert: true, maskMode: "luminance", fills: [{ type: "solid", color: "#FFFFFF" }], ...extra });

  const matrixOf = (el: DesignElement): number[] => {
    const filter = maskAlphaFilterDef(el) as any;
    return String(filter.props.children.props.values).trim().split(/\s+/).map(Number);
  };

  it("flips each channel, because colour IS the channel in luminance mode", () => {
    const values = matrixOf(inverted());

    expect(values).toHaveLength(20);
    // `luminance(1 - c)` is `1 - luminance(c)`: a black pixel of the photo now
    // reveals and a white one hides.
    expect(values.slice(0, 15).join(" ")).toBe("-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1");
    // Alpha is untouched — the layer still masks only where it paints.
    expect(values.slice(15).join(" ")).toBe("0 0 0 1 0");
  });

  it("is ignored in alpha mode, where the adapter still normalizes to white", () => {
    const el = rect({ maskInvert: true, fills: [{ type: "image", assetId: "a1" }] });

    // `A' = 1 - A` would reveal the region the layer leaves empty; the mask is
    // the paint's transparency and nothing about it changes.
    expect(matrixOf(el).slice(0, 15).join(" ")).toBe("0 0 0 0 1 0 0 0 0 1 0 0 0 0 1");
    expect(matrixOf(el).slice(15).join(" ")).toBe("0 0 0 1 0");
    expect(maskIsClip(rect({ maskInvert: true, fills: [{ type: "solid", color: "#000000" }] }))).toBe(true);
  });

  it("leaves the layer's own opacity where it was — after the filter", () => {
    // The channel is inverted first and the opacity scales the result, which is
    // what carrying `opacity` on the group has always meant.
    expect(group(render(inverted({ opacity: 0.5 }))).props.opacity).toBe(0.5);
  });

  it("reaches its filter even in luminance mode, which otherwise needs none", () => {
    expect(group(render(inverted())).props.filter).toBe("url(#maskalpha_m)");
    expect(group(render(rect({ maskMode: "luminance", fills: [{ type: "solid", color: "#FFFFFF" }] }))).props.filter).toBeUndefined();
  });

  it("carries the filter outside the layer's own translate", () => {
    // A `userSpaceOnUse` region is read in the user space of the element that
    // carries the filter, so a filter on the translated group put the region at
    // the layer's origin a SECOND time: measured, only part of the paint came
    // out inverted.
    const mask = render(inverted());

    expect(group(mask).props.filter).toBe("url(#maskalpha_m)");
    expect(group(mask).props.transform).toBeUndefined();
    expect(stencil(mask).props.transform).toBe("translate(10, 20) rotate(0 100 75)");
  });

  it("keeps a blurred inverted mask on one matrix followed by the blur", () => {
    const el = inverted({ effects: [{ type: "layer-blur", blur: 40, enabled: true }] });
    const filter = maskAlphaFilterDef(el) as any;

    expect(byTag(filter, "feColorMatrix")).toHaveLength(1);
    expect(byTag(filter, "feGaussianBlur")[0].props.in).toBe("mask_alpha");
  });

  it("needs no region of its own — brightness cannot reveal an unpainted pixel", () => {
    // `luminance x alpha` is 0 wherever the layer paints nothing, so inverting
    // the brightness cannot reach outside the region a normal mask already has.
    const mask = render(inverted());
    const plain = render(rect({ maskMode: "luminance", fills: [{ type: "solid", color: "#FFFFFF" }] }));
    const filter = maskAlphaFilterDef(inverted()) as any;

    expect([mask.props.x, mask.props.y, mask.props.width, mask.props.height]).toEqual([
      plain.props.x,
      plain.props.y,
      plain.props.width,
      plain.props.height
    ]);
    for (const axis of ["x", "y", "width", "height"]) expect(filter.props[axis]).toBe(mask.props[axis]);
  });

  it("cannot be stated as a clip, and does not clip a backdrop by outline", () => {
    const el = inverted({ fills: [{ type: "solid", color: "#FFFFFF" }] });

    expect(maskIsClip(el)).toBe(false);
    expect(maskClipDef(el)).toBeNull();
    expect(maskBackdropClip(el)).toBeNull();
  });

  it("is a stored property, written as the CSS-shaped mask-invert", () => {
    const { document } = normalizeDesignDocument(
      {
        version: versions.current,
        canvas: { width: 100, height: 100, unit: "px" },
        elements: [
          { id: "m", type: "rect", x: 0, y: 0, width: 10, height: 10, isMask: true, maskMode: "luminance", maskInvert: true }
        ]
      } as never,
      { preserveUnknown: true }
    );
    const el = getActivePage(document).children[0] as DesignElement;

    expect(el.maskInvert).toBe(true);
    const file = JSON.parse(documentJson(document)) as any;
    expect(file.pages[0].children[0]["mask-invert"]).toBe(true);
    expect(file.pages[0].children[0]).not.toHaveProperty("maskInvert");
    // And the kebab spelling it wrote is the one the reader takes back.
    expect(normalizeDesignDocument(file).document.pages[0].children).toEqual(document.pages[0].children);
  });

  it("is published in the schema", () => {
    expect(schema.definitions.DesignElement.properties.maskInvert.type).toBe("boolean");
  });
});

describe("maskMode is only offered where it can change the result", () => {
  const grad = { type: "linear-gradient", stops: [] } as any;
  const img: Paint = { type: "image", assetId: "a1" };

  it("offers nothing for solid fills, whose colour is one value everywhere", () => {
    // `luminance` on a solid reads a constant — which is what `opacity` already
    // says — so the two options would render identically and the control would be
    // a lie about there being a choice.
    expect(maskChannelVaries(undefined)).toBe(false);
    expect(maskChannelVaries([])).toBe(false);
    expect(maskChannelVaries([{ type: "solid", color: "#FFFFFF" }])).toBe(false);
    expect(maskChannelVaries([{ type: "solid", color: "#000000" }])).toBe(false);
  });

  it("offers the choice as soon as a gradient or an image joins the stack", () => {
    expect(maskChannelVaries([grad])).toBe(true);
    expect(maskChannelVaries([img])).toBe(true);
    // A solid underneath an image does not disqualify the image.
    expect(maskChannelVaries([{ type: "solid", color: "#FFFFFF" }, img])).toBe(true);
  });

  it("ignores a hidden layer, which contributes no pixels to the mask", () => {
    expect(maskChannelVaries([{ type: "image", assetId: "a1", enabled: false }])).toBe(false);
  });
});

describe("maskMode is a stored, validated property", () => {
  it("accepts the schema's vocabulary and refuses anything else", () => {
    expect([...MASK_MODES]).toEqual(["alpha", "luminance"]);
    expect(normalizeMaskMode("alpha")).toBe("alpha");
    expect(normalizeMaskMode("LUMINANCE")).toBe("luminance");
    // Dropped, not guessed: defaulting a typo to `luminance` would silently turn
    // every "shows through" pixel into a brightness test.
    expect(normalizeMaskMode("lumenance")).toBeUndefined();
    expect(normalizeMaskMode(7)).toBeUndefined();
  });

  it("survives a load, which is where a key the engine never reads is lost", () => {
    for (const mode of MASK_MODES) {
      const { document } = normalizeDesignDocument(
        {
          version: versions.current,
          canvas: { width: 100, height: 100, unit: "px" },
          elements: [{ id: "m", type: "rect", x: 0, y: 0, width: 10, height: 10, isMask: true, maskMode: mode }]
        } as never,
        { preserveUnknown: true }
      );
      expect((getActivePage(document).children[0] as DesignElement).maskMode).toBe(mode);
    }
  });

  it("is published in the schema with the mode set the engine accepts", () => {
    // The schema is what an external author reads, so it has to offer exactly the
    // modes `normalizeMaskMode` accepts — no more, and no fewer.
    expect(schema.definitions.MaskMode.enum).toEqual([...MASK_MODES]);
  });

  it("refuses clip-path lowering and emits bounded feGaussianBlur when a mask carries layer-blur", () => {
    const blurredMask = rect({
      x: 60,
      y: 60,
      width: 414,
      height: 566,
      borderRadius: 34,
      fills: [{ type: "solid", color: "#FF0000" }],
      effects: [{ type: "layer-blur", blur: 120, enabled: true }]
    });
    expect(maskIsClip(blurredMask)).toBe(false);
    expect(maskClipDef(blurredMask)).toBeNull();
    const mask = render(blurredMask);
    const filter = maskAlphaFilterDef(blurredMask) as any;
    const blurs = byTag(filter, "feGaussianBlur");
    expect(blurs).toHaveLength(1);
    expect(blurs[0].props.stdDeviation).toBe(60);
    expect(filter.props.width).toBeLessThan(2000);
    expect(filter.props.height).toBeLessThan(2000);
    expect(mask.props.width).toBe(filter.props.width);
    expect(mask.props.height).toBe(filter.props.height);
  });
});

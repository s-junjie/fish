// Runtime copy of the enum vocabularies declared in fish.schema.json. The JSON
// stays the single source and is NOT bundled — these constants exist so the
// ~16KB schema never enters the shell. tests/version-consistency.test.ts
// asserts every list against the JSON and fails when they drift.
export const ELEMENT_TYPES = [
  "frame",
  "component",
  "componentSet",
  "instance",
  "text",
  "rect",
  "ellipse",
  "polygon",
  "star",
  "path",
  "line",
  "arrow",
  "video",
  "html"
] as const;

export const AUTO_LAYOUT_MODES = ["flex", "grid", "none"] as const;

export const AUTO_LAYOUT_DIRECTIONS = ["row", "column"] as const;

export const PAINT_TYPES = [
  "solid",
  "linear-gradient",
  "radial-gradient",
  "angular-gradient",
  "diamond-gradient",
  "image",
  "pattern"
] as const;

/** The procedurally drawn tiling motifs. Each one has both an SVG and a CSS form. */
export const PATTERN_MOTIFS = [
  "dots",
  "grid",
  "diagonal-stripes",
  "crosshatch",
  "checker"
] as const;

/** Figma's tile layouts. The hexagonal pair repeats a doubled, offset tile. */
export const PATTERN_TILE_TYPES = [
  "rectangular",
  "horizontal-hexagonal",
  "vertical-hexagonal"
] as const;

/** Where a tile grid starts on the element's box, Figma's `horizontalAlignment`. */
export const PATTERN_ALIGNMENTS = ["start", "center", "end"] as const;

/** The paint kinds whose colour varies across the shape, i.e. the ones that
 *  carry `from`/`to` (or `stops`) and are consumed as `url(#grad_*)` on canvas. */
export const GRADIENT_PAINT_TYPES = [
  "linear-gradient",
  "radial-gradient",
  "angular-gradient",
  "diamond-gradient"
] as const;

export const EFFECT_TYPES = [
  "drop-shadow",
  "inner-shadow",
  "layer-blur",
  "backdrop-blur",
  "liquid-glass",
  "tear"
] as const;

export const WIDTH_SIZING_MODES = ["fixed", "fit-content", "max-content", "fill"] as const;

export const MASK_MODES = ["alpha", "luminance"] as const;

/** Which side of the box carries a break. */
export const EDGE_SIDES = ["top", "right", "bottom", "left"] as const;

/** Which scalar field replaces the edge. Order is the menu's order. */
export const EDGE_PROFILES = ["torn", "scallop", "zigzag"] as const;

/** Which of the three things a tear is. Order is the panel's order. */
export const TEAR_FORMS = ["edge", "hole", "scrap"] as const;


export const BLEND_MODES = [
  "normal",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "plus-lighter",
  "color-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity"
] as const;

export const SLIDE_TRANSITIONS = ["none", "dissolve", "push", "slide", "morph"] as const;

export const SLIDE_EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out"] as const;

export const SLIDE_DIRECTIONS = ["left", "right", "up", "down"] as const;

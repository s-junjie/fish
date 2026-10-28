/**
 * Translation shim for `scripts/probe-modify-loop.mjs`.
 *
 * The modify-loop metric needs the SAME corpus in two vocabularies: the DSL the
 * engine stores today, and the CSS vocabulary storing CSS layout names would
 * produce. The shim is the only thing that makes the delta measurable before the
 * rename exists — without it, there is nothing to compare against.
 *
 * Two directions:
 *   - `toCssStore(el)` renames stored keys to their CSS spelling, the way the
 *     agent would READ them under P2. `display:flex` instead of
 *     `layout:{mode:"flex"}`, `font-size` instead of `style.fontSize`,
 *     `position` instead of `layoutPosition`.
 *   - `toDslStore(el)` is the inverse, standing in for the P2 readers: the
 *     patch the agent writes in CSS spelling is translated back to DSL before
 *     the (unchanged) engine reads it.
 *
 * The map is the §2 rename table, restricted to the keys a modify loop actually
 * touches. It is deliberately small and explicit — an over-broad shim would
 * manufacture a delta that P2's real readers could not deliver.
 */

const LAYOUT_TO_CSS = {
  mode: "display",
  direction: "flex-direction",
  gap: "gap",
  rowGap: "row-gap",
  columnGap: "column-gap",
  padding: "padding",
  justify: "justify-content",
  align: "align-items",
  alignContent: "align-content",
  wrap: "flex-wrap"
};

const TEXT_TO_CSS = {
  fontSize: "font-size",
  fontWeight: "font-weight",
  fontFamily: "font-family",
  fontStyle: "font-style",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  align: "text-align",
  textTransform: "text-transform",
  textDecoration: "text-decoration"
};

// `false` = not part of the rename; kept out so a value shape the engine cannot
// round-trip (a `layoutCell` -> `grid-column` translation needs a parser) never
// fabricates rework in one column only.
const ELEMENT_TO_CSS = {
  layoutPosition: "position",
  layoutMargin: "margin",
  layoutAlignSelf: "align-self",
  flexGrow: "flex-grow"
};

const invert = (map) => Object.fromEntries(Object.entries(map).map(([dsl, css]) => [css, dsl]));

const LAYOUT_FROM_CSS = invert(LAYOUT_TO_CSS);
const TEXT_FROM_CSS = invert(TEXT_TO_CSS);
const ELEMENT_FROM_CSS = invert(ELEMENT_TO_CSS);

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function mapChildren(el, fn) {
  if (!Array.isArray(el.children)) return;
  el.children = el.children.map(fn);
}

/** DSL element -> the CSS-named element the agent would read under P2. */
export function toCssStore(el) {
  if (!isObject(el)) return el;
  const css = { ...el };

  if (isObject(el.layout)) {
    const rest = { ...el.layout };
    for (const [dslKey, cssKey] of Object.entries(LAYOUT_TO_CSS)) {
      if (rest[dslKey] !== undefined) {
        css[cssKey] = rest[dslKey];
        delete rest[dslKey];
      }
    }
    delete css.layout;
    if (Object.keys(rest).length > 0) css.layout = rest;
  }

  if (el.type === "text" && isObject(el.style)) {
    const rest = { ...el.style };
    for (const [dslKey, cssKey] of Object.entries(TEXT_TO_CSS)) {
      if (rest[dslKey] !== undefined && rest[cssKey] === undefined) {
        css[cssKey] = rest[dslKey];
        delete rest[dslKey];
      }
    }
    delete css.style;
    if (Object.keys(rest).length > 0) css.style = rest;
  }

  for (const [dslKey, cssKey] of Object.entries(ELEMENT_TO_CSS)) {
    if (css[dslKey] !== undefined && css[cssKey] === undefined) {
      css[cssKey] = css[dslKey];
      delete css[dslKey];
    }
  }

  mapChildren(css, toCssStore);
  return css;
}

/** CSS-named element -> the DSL element the unchanged engine must read. */
export function toDslStore(el) {
  if (!isObject(el)) return el;
  const dsl = { ...el };

  const layout = isObject(el.layout) ? { ...el.layout } : {};
  for (const [cssKey, dslKey] of Object.entries(LAYOUT_FROM_CSS)) {
    if (el[cssKey] !== undefined) {
      layout[dslKey] = el[cssKey];
      delete dsl[cssKey];
    }
  }
  if (Object.keys(layout).length > 0) dsl.layout = layout;
  else delete dsl.layout;

  if (el.type === "text") {
    const style = isObject(el.style) ? { ...el.style } : {};
    for (const [cssKey, dslKey] of Object.entries(TEXT_FROM_CSS)) {
      if (el[cssKey] !== undefined) {
        style[dslKey] = el[cssKey];
        delete dsl[cssKey];
      }
    }
    if (Object.keys(style).length > 0) dsl.style = style;
    else delete dsl.style;
  }

  for (const [cssKey, dslKey] of Object.entries(ELEMENT_FROM_CSS)) {
    if (el[cssKey] !== undefined) {
      dsl[dslKey] = el[cssKey];
      delete dsl[cssKey];
    }
  }

  mapChildren(dsl, toDslStore);
  return dsl;
}

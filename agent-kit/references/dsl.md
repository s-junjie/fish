# FISH DSL Reference

This reference is for agents authoring FISH single-file HTML documents (`*.fish.html`): the document model, tokens and styles, element primitives, CSS deltas, paint, typography, components, and the traps that do not announce themselves.

## Reference & Canonical Schema

Inspect `templates/blank.fish.html` for the container shape (`#design-doc`, `#fish-assets`, `#fish-comments` hold document data; `#fish-rt-css`, `#fish-rt`, and the inline loader are shell-owned — mutate only through `./tools/fish`).

Three layers, in order of authority:

1. **`fish check` / the normalizer** — the executable truth.
2. **`tools/fish.schema.json`** — the published contract: one spelling per key, the one the file writes. Aliases are not published. It is a large reference file: instead of loading it whole, run `./tools/fish schema` to list definitions and keys, `--find <word>` to search descriptions/enums, or `./tools/fish schema <key|Def>` (`--json` for a machine) to inspect one. It is descriptive, not the runtime validator.
3. **This document** — DSL structure, tokens/styles, element primitives, CSS deltas, silent traps, and `--geometry`/`--audit` diagnostic definitions. CLI command syntax lives in `./tools/fish --help`; end-to-end authoring workflows live in `workflow.md`. If this file disagrees with the schema or engine, the schema/engine wins.

### HTML In — Seed vs Embed

- **`fish import page.html` (authoring seed)**: measures rendered flex/grid/text in headless Chromium into editable DSL elements (`workflow.md §2`). Page `id` attributes (`A-Za-z0-9_-`) become element `id`s (collisions or invalid chars mint new ids listed in `unmapped`; fixed-viewport; baked positions listed in `downgraded`). Seed only — never re-import over an edited `.fish.html`.
- **`type: "html"` (view-only iframe)**: displays external `src` or inline `srcdoc` with optional `posterAssetId`; contents are not FISH elements, cannot be edited, and drop from static SVG/PNG exports.

### Diagnostics (`check --geometry` & `check --audit`)

- **`--geometry` (Node, no browser)**:
  - `overflow` — in-flow child extends beyond container content box (often text missing a width mode).
  - `clipped` — child painted box (including rotation) is clipped by an ancestor with `overflow: "hidden" | "auto"`.
  - `zero-size` (`warning`) — painted container with children collapsed to `0px` on an axis.
  - `unused-space` (`info`) — downward stack ends well short of a fixed `height` (prefer `fit-content`).
  - `guide-degenerate` (`warning`) — layout guide renders no bands/grid (`count: 0`, `size: 0`, `margin` leaves no room, or gutters eat box).
- **`--audit` (headless browser + report channel; reports `NOT RUN` on shells without it)**:
  - `align-not-applied` / `vertical-align-not-applied` — raw `#design-doc` alignment differs from computed style (vertical compares stored `vertical-align` against flex `justify-content`: `middle ↔ center`, `top ↔ flex-start`).
  - `ink-not-centred` / `ink-not-right` / `ink-not-centred-y` — glyph ink misses box centre/edge by > tolerance (`vertical` fires only when vertical alignment was explicitly claimed).
  - `group-not-centred` (`warning`) — label misses centre of a same-line companion icon (within one gutter, comparable height, excluding background/full-bleed textures).
  - `no-ink` — text box has content but renders no visible ink (`textPath` is skipped with reason; empty boxes are skipped).
  - **Tolerance**: defaults to `1px`; pass `--audit-tolerance N` (`0.25–16` canvas px) for graphic layouts.

## Document Structure

FISH documents encapsulate state in a single JSON block:

```html
<script id="design-doc" type="application/json">
{
  "version": "0.1",
  "name": "My Design",
  "canvas": { "width": 1920, "height": 1080, "background": { "type": "solid", "color": "#0D0D0D" } },
  "pages": [{ "id": "page_1", "name": "Page 1", "children": [...] }],
  "activePageId": "page_1"
}
</script>
```

- **Dialect**: `"version": "0.1"` is required.
- **Variables & Math**: `variables: { "--color": "#FFF" }` resolves `var(--color, fallback)` — and `var(--token-name)` also falls back to matching `doc.tokens[]` entries (`variables` takes precedence). Inside a bindable token slot, a whole-value `var(--token-name)` binds live (`tokenId` / `tokenBindings`) just like `$token-name`; inside compound `calc()` or non-bindable slots, `var(--token-name)` substitutes the token's value for the node's active mode at load/op time. Length values support px, bare numbers, `rem` (16px), and constant `calc()` / `min()` / `max()` / `clamp()`.
  This `variables` table is **authoring-time substitution only** when not backed by `doc.tokens[]`. For reusable, mode-aware values across edits, declare them in [Design Tokens & Styles](#design-tokens--styles).
- **Pages**: A page holds its tree in `children`, and that is the only place it lives: `pages: [{ id, name, canvas, children }]` + `activePageId`. A single-page document may instead carry a top-level `elements` array; the reader adopts it into page 1 and never writes it back, so prefer `pages`.
- **Presentation backdrop**: `canvas.presentBackground: true` paints that canvas `background` behind every slide while presenting, instead of the editor's paper surface. It is a deck setting only — the editing canvas is unchanged. The deck's own **Canvas background** switch writes it, per page.
- **Relaxed JSON**: Comments (`//`, `/* */`) and trailing commas are accepted on parse. String values containing `</` must escape it as `\u003c/`.

## Design Tokens & Styles

Two tables, and which table an entry is in **is** its role: `doc.tokens[]` holds a value (a colour or a number), `doc.styles[]` holds a set of declarations a layer applies. A reference that crosses the tables is an error, not a warning.

```json
{
  "tokens": [
    { "id": "tok_surface", "name": "color/surface", "type": "color",
      "value": "#FFFFFF", "modes": { "dark": "#0A0A0A" } },
    { "id": "tok_scrim", "name": "color/scrim", "type": "color", "value": "#00000066" },
    { "id": "tok_radius", "name": "radius/card", "type": "number", "value": 12, "category": "radius" }
  ],
  "styles": [
    { "id": "style_card", "name": "surface/card", "styleType": "paint",
      "paints": [{ "type": "solid", "color": "#FFFFFF", "tokenId": "tok_surface" }] }
  ],
  "modes": [{ "id": "light", "name": "Light" }, { "id": "dark", "name": "Dark" }],
  "activeTheme": "dark"
}
```

| Table | `type` / `styleType` | Payload | How a layer points at it |
| :-- | :-- | :-- | :-- |
| `tokens` | `color` | `value`, `modes?` — one hex, alpha in the last byte | `fills[].tokenId`, `fills[].stops[].tokenId`, `strokes[].tokenId`, `effects[].tokenId` |
| `tokens` | `number` | `value` (px), `category?`, `modes?` | `tokenBindings: { prop: tokenId }` |
| `styles` | `paint` | `paints` (one solid, a gradient, or a stack) | `fillStyleId` |
| `styles` | `text` | `style` | `textStyleId` |
| `styles` | `effect` | `effects` | `effectStyleId` |
| `styles` | `stroke` | `strokes` | `strokeStyleId` |

Five consequences worth knowing before authoring:

- **A colour token is one value, not a paint.** `value` is `#RGB`, `#RRGGBB` or `#RRGGBBAA` (or `transparent`); translucency is the last byte, and there is no `opacity` field on a token.
- **A style has no `modes`.** A style that must change per mode follows a token: `paints[0].tokenId`, `style.tokenBindings`, `effects[].tokenId`. The chain resolves token → style → layer.
- **A one-solid paint style is a legal style** — but if the thing you are naming IS the colour, use a colour token. The UI only creates tokens for single colours.
- **`styleType: "number"` and `modes` on a style are not read.** Number values belong in `doc.tokens[]`; a style changes per mode by following a token.
- **Alias tokens are direct, same-type references.** Any `tokens[].value` or `tokens[].modes[modeId]` slot may hold `{ "ref": "tok_..." }` pointing to another token of the same `type` (`color → color`, `number → number`), forming a DAG (no cycles, no modifiers/expressions). When authoring by hand, write `"$name"` (id, exact name, or slug) in that slot — `normalize` expands it to `{ "ref": "<id>" }`.

**Referencing** (the value stays materialised beside the id; the engine rewrites it in the same commit when the token changes):

| Field | Points at | Use |
| :-- | :-- | :-- |
| `fills[].tokenId` | colour token | One paint layer follows the token. |
| `fills[].stops[].tokenId` | colour token | One gradient stop follows the token; `color` stays materialised beside it. Editing that colour detaches the stop. |
| `strokes[].tokenId` / `strokes[].paint.tokenId` | colour token | Stroke colour follows the token. |
| `effects[].tokenId` / `effects[].tokenBindings` | colour token / number token | Shadow colour or radius follows the token. |
| `tokenBindings: { prop: tokenId }` | number token | `borderRadius`, the four corners `borderTopLeftRadius` / `borderTopRightRadius` / `borderBottomRightRadius` / `borderBottomLeftRadius`, `gap`, `row-gap`, `column-gap`, `padding`, `paddingTop` / `paddingRight` / `paddingBottom` / `paddingLeft`, `strokeWidth`, `fontSize`, `lineHeight`, `letterSpacing`, `width`, `height`. |
| `fillStyleId` / `strokeStyleId` / `effectStyleId` / `textStyleId` | a style id | The layer uses that named style; the engine copies its values in — naming it is enough, do not spell the same declarations out on the layer as well. |

- **Modes** are token configuration, not a second set of styles. See [Modes](#modes).

### Token shorthand (`$name` and `var(--name)`)

An id is minted (`tok_<replica>_<time>_<n>`), so a hand-written document cannot name a token by id. Write the **name** instead (`$name` or `var(--name)`), in the slot the value belongs to:

```jsonc
{ "type": "frame", "display": "flex",
  "gap": "$space-md", "padding": "$space-lg", "border-radius": "var(--radius-card)",
  "background": "$color-surface", "border": "1px solid $color-border" }
```

- **What `$x` / `var(--x)` may be**: the token id, its exact `name` (`$color/surface`), or its slug — same name lower-cased with `/` and spaces folded to `-` (`$color-surface`, `var(--color-surface)`). Id first, then name, then slug; two tokens landing on one slug is reported, never guessed. `variables` overrides `var(--x)` when the same name appears in both `doc.variables` and `doc.tokens[]`; `var(--x, fallback)` unwraps the fallback when `--x` is absent from both.
- **Where it is read**: colour — `background`, `color`, the colour inside `border`, `fills[i].color` / `strokes[i].color` / `effects[i].color`, `doc.styles[]`, and `spans[i].style.color`. Number — `gap`, `row-gap`, `column-gap`, `padding` (scalar, 1–4 array/string shorthand, or `{ top, right, bottom, left }` / `{ t, r, b, l }` side objects), `width`, `height`, `border-radius` and the four corner radii, `stroke-width`, `font-size`, `line-height`, `letter-spacing`, and `spans[i].style.fontSize` / `letterSpacing`. Inside compound expressions such as `calc(100% - var(--space-md))` or unbindable properties such as `margin`, `var(--name)` resolves against active element modes without creating a binding.
- **What it writes**: the reference AND the value, in the active modes — the same pair the inspector writes when you bind a token (`fills[].tokenId` + `color`, `tokenBindings` + the number). Authoring numeric `width` / `height` tokens also pins that axis to `"fixed"` sizing (`fills`/`spans` follow the rules below). The stored file never contains `$` or resolved `var()`.
- **`tokenId` and `tokenBindings` accept a name too**, so `"tokenBindings": { "gap": "space/md" }` resolves to the same entry without you knowing its id.
- **Not supported**: a token inside a per-side `border-top` (one colour covers every side; write it in `border`), a token inside a `boxShadow` string (write the shadow as an `effects[]` entry with `color` + `tokenId`), and per-side `border-top-width` (bind `strokeWidth`).
- **A wrong `$x` (or a `var(--x)` with no entry in `variables` or `tokens[]` and no fallback) is an error, not a guess**: the declaration is dropped or reported as an unresolved custom property, which fails `fish check`.

- **Dangling references**: an id no `doc.tokens[]` / `doc.styles[]` entry backs still renders from the materialised literal, but it cannot be edited and every edit detaches it. `fish check` warns about one, and errors when an id is in the WRONG table.
- **Authoring rule**: if a value repeats, or is one of a scale (spacing steps, radii, type sizes, palette), make it a token and reference it. Two layers that must change together should share an id, not two identical literals.

### Modes

A mode is a named variant of the token table, not a parallel document. Define it once; every layer bound to a token follows it.

```json
"tokens": [
  { "id": "tok_surface", "type": "color", "value": "#FFFFFF",
    "modes": { "dark": "#0A0A0A" } }
],
"modes": [{ "id": "light", "name": "Light" }, { "id": "dark", "name": "Dark" }],
"activeTheme": "dark"
```

- `activeTheme` selects the document default; `themeMode` on a container overrides it for that subtree.
- Put per-mode values on the token (`tokens[].modes`), not on a style. A style has no `modes`; it follows a token through `paints[].tokenId`, `tokenBindings`, or `effects[].tokenId`.
- Only token- and style-bound values switch. Literal colours, `page.canvas.background`, and nodes outside the `themeMode` subtree keep the mode they resolved under. A token with no entry for the active mode falls back to `value`.
- Name modes by role (`light`, `dark`, `brand`), not by the colour they happen to use.

There is a **second, independent axis for NUMBER tokens**. Brightness (colour) and density (number) are different concerns: a dark-mode switch must never move every radius. Both axes therefore live side by side on the document:

```json
{
  "modes": [{ "id": "light", "name": "Light" }, { "id": "dark", "name": "Dark" }],
  "activeTheme": "dark",
  "numberModes": [{ "id": "compact", "name": "Compact" }, { "id": "mobile", "name": "Mobile" }],
  "activeNumberMode": "compact",
  "tokens": [
    { "id": "tok_radius", "type": "number", "value": 12, "category": "radius",
      "modes": { "compact": 8, "mobile": 6 } }
  ]
}
```

- `numberModes[]` / `activeNumberMode` mirror `modes[]` / `activeTheme` exactly: `activeNumberMode` selects the document default, `numberMode` on a container overrides it for that subtree (and is an allowed `overrides[].property`). Omitted `numberModes` means a single default mode — a document that never varies by density should not declare any.
- A **number token's `modes` map is keyed by NUMBER mode ids**, never by colour mode ids. The two key spaces are separate registries; putting a colour-mode key on a number token (or vice versa) silently falls back to `value`.
- Resolution is `element.numberMode → activeNumberMode → effectiveTheme → `token.value` — the last hop is the legacy bridge: files written before the split filed number values under colour mode ids, and `normalize` adopts those ids as the number axis so an old file keeps its per-mode numbers.
- Same fallback rules as the colour axis: a token with no entry for the active number mode uses `value`, and only token-bound values switch (`tokenBindings`, `effects[].tokenId` for radius). `fish check` warns when `activeNumberMode` names a mode `numberModes[]` does not declare.
- Name number modes by role (`compact`, `mobile`), not by the values they happen to hold.

## Element Primitives

All scene nodes belong to one of these types:

| `type` | Payload keys | Notes |
| :-- | :-- | :-- |
| `frame` | `children`, auto-layout keys, `overflow`, `border-radius`, `cornerSmoothing`, `fills`, `strokes` | Sole structural container. |
| `component` | as `frame` + `setId`, `variantProperties` | Reusable master component or set variant. |
| `componentSet` | `children`, `name`, `variantGroupProperties`, auto-layout keys | Container for component variants. Holds `component` children only; opt into Auto-Layout (`display: flex` / `grid`) or omit `display` for free-form positioning. |
| `instance` | `componentId`, `width`, `height`, `sizeOverride`, `overrides` (+ base element keys) | Renders master subtree; carries no `children`. As a canvas element, the instance itself supports all standard transforms (`rotate`, `scale`), coordinates, opacity, and paint. `componentId` must point at a `type:"component"` node — a `frame` is not a master and renders as a dashed empty box. An omitted width/height is copied from the master. |
| `text` | `content`, `style`, `spans`, `onPath` | Text element. Glyphs paint via `fills` (default black). |
| `rect` | `fills`, `strokes`, `border-radius`, `cornerSmoothing` | Rectangle / card shape. |
| `ellipse` | `fills`, `strokes`, `sweep`, `startAngle`, `innerRadius`, `gap` | Ellipse, pie slice, donut, gauge. |
| `polygon` | `sides` (3..24), `border-radius`, `cornerSmoothing`, `fills`, `strokes` | Regular polygon. |
| `star` | `points` (3..24), `innerRadius` (0..0.99), `border-radius`, `cornerSmoothing`, `fills`, `strokes` | Regular star. `points` counts spikes. |
| `path` | `d`, `fills`, `strokes`, `fill-rule` | Freeform vector path. |
| `line` | `dx`, `dy`, `strokes` | Line segment from `(x, y)` to `(x+dx, y+dy)`. |
| `arrow` | `dx`, `dy`, `strokes` | Vector arrow with head at `(x+dx, y+dy)`. |
| `video` | `assetId`, `autoplay`, `loop`, `muted`, `controls`, `border-radius` | Embedded or external video player. |
| `html` | `src` or `srcdoc`, `border-radius` | Embedded web page. Dropped on static PNG/SVG export. |

## CSS-Diff (How FISH Differs From Standard CSS)

FISH reads a fixed subset of CSS. This document names the common surface and the known deltas; it is not an exhaustive key list. The authoritative accepted surface is the normalizer and `tools/fish.schema.json` — run `./tools/fish schema` to list definitions/keys, `--find <word>` to search, or `./tools/fish schema <key|Def>` instead of reading that file whole; when unsure, run `fish check`, which reports an unknown property instead of guessing.

**Spelling — one per key.** The file speaks CSS. Write the CSS property name where CSS has one (`border-radius`, `flex-direction`, `font-size`), and the DSL name only where CSS has no equivalent (`layoutGuides`, `componentId`, `tokenBindings`). `tools/fish.schema.json` publishes exactly that one spelling; `./tools/fish schema <key>` inspects it and resolves any element alias you may have seen in an imported or older file.

The other spellings are **input-only aliases**: the normalizer accepts them so imported pages and legacy documents still load, but they are never written back and are not in the schema. Do not author them. Two places use internal field names instead of element keys and are the exception — `overrides[].property` and `tokenBindings` keys (`borderRadius`, `borderTopLeftRadius`) name a field inside the master/binding, not a key on the element.

A key in `snake_case` is refused by name. A declaration the engine cannot carry is reported as a dropped property; nothing is accepted and then quietly ignored.

### 1. Coordinates & Box Model
- **Local Coordinate Convention**: Top-level artboards sit at canvas `(x, y)`. All children of `frame` and `component` use **local coordinates relative to parent top-left `(0, 0)`**. Moving a parent never alters child coordinates.
- **Free Placement vs Auto-Layout**: Omitting `display` on a frame/component creates a **free-placement canvas** (NOT CSS block flow): every child needs explicit `x`/`y`, or children overlap at `(0, 0)`. To stack children sequentially or wrap them in a flow, declare `display: "flex"` or `"grid"`.
- **Composed overlap**: A free-placement container whose children are meant to sit on top of each other — a wordmark over a display glyph, a caption over a photograph — declares `overlap: "allowed"` on itself. It silences the text-overlap finding for that container and everything it holds; layout and paint never read it. Omit it everywhere else, so an accidental collision still surfaces.
- **In-Flow Children**: Children inside an auto-layout container (`display: "flex"` or `"grid"`) have their positions computed automatically; `x`/`y` are **ignored** unless the child says `position: "absolute"`. Omit them or write `(0, 0)`. Coordinates left on an in-flow child are the one silent mistake this dialect allows — the flow wins, and `fish check` names it: `x/y (16, 14) are ignored by the auto-layout of "capsule" (flex) — the flow places it at (0, 14.5)`.
- **Absolute Positioning**: `position: "absolute"` takes a child out of auto-layout flow. Requires explicit `x`, `y`, `width`, `height`. Always write `position` (`layoutPosition` and `layoutAlignSelf` / `layoutMargin` / `layoutCell` are pre-rename keys the dialect **refuses** — they are dropped with a repair, not migrated).
- **Box Sizing**: Always **border-box** (`box-sizing: content-box` is not supported). Enabled `align: "inside"` strokes (including CSS `border` / `border-*` declarations) are deducted from container content boxes alongside `padding` in flex, grid, and `%`/`calc()` child sizing.
- **Transforms**: write them as CSS — `rotate: "45deg"` (clockwise around the element centre), `scale: "-1 1"` to mirror horizontally / `"1 -1"` vertically, `transform: "rotateX(20deg)"` for the 3D tilt, `skewX` / `skewY` (degrees, ±89) to shear the box about its centre. `perspective` (px, default 800) sets the projection depth. These are baked to bitmap on export. A shear is applied inside the rotation, and a pair whose tangents multiply to 1 (`skewX: 45` beside `skewY: 45`) flattens the box to a line — that pair is refused with a repair rather than stored.
- **Constraints**: For absolute or plain-frame children: `constraints: { horizontal: "left" | "right" | "center" | "stretch" | "scale", vertical: "top" | "bottom" | "center" | "stretch" | "scale" }`.
- **Clipping & Scrolling**: one property, CSS's three values. `overflow: "hidden"` cuts children at the box edge; `"auto"` clips and scrolls whichever axis actually overflows — the direction is MEASURED from the children, never written; `"visible"` is CSS's initial value and is normally omitted, so an `overflow` in the file always means someone decided to clip. To lock one axis (a vertical list that must not be dragged sideways), add the longhand: `overflow: "auto"` beside `overflow-x: "hidden"`. Never write `scroll` — it means "always paint a scrollbar" in CSS, and this engine paints none. The scroll POSITION has no CSS property — a browser keeps it as DOM state — so it is `scroll-x` / `scroll-y` in px. Children inside a scrolling frame can pin via `scroll-behavior: "scroll" | "fixed" | "sticky"` (scroll pinning, NOT CSS smooth-scroll behavior).

### 2. Auto-Layout (Flex & Grid)
Keys are stored flat on the container using CSS names. A nested `layout` object or a compact `layout` string is not read: write `display` plus the flat keys. Only these points differ from standard CSS:
- `display: "flex" | "grid"`; omit it for free canvas placement. Do **not** write `"block"` expecting CSS vertical block flow — `"block"` is free placement (children keep their `x`/`y`) and is **reported** (use `display: "flex", "flex-direction": "column"` to stack children). `"none"` is free placement too, and is **reported** as well: CSS's `display: none` removes the box while this keeps it visible — hiding is `visible: false`. A gap, padding or direction beside a free-placed frame is dropped and **reported** (`"padding" needs a layout`) — those keys exist only inside a layout pass.
- `gap`, `row-gap`, `column-gap`, `padding`, `margin` take a number, a tuple, or a CSS shorthand string; the file writes the shorthand.
- `align-items` on a grid container is cell alignment; `align-content` is the line axis.
- `align-self` overrides the parent's `align-items`. A positive `flex-grow` implies `sizing` fill along the parent's main axis.
- `grid-column` / `grid-row` write CSS line ranges (`"2 / span 2"`, `"span 2"`, `"3"`); `grid-area` (`{ column, row, columnSpan, rowSpan }` or 4-part CSS shorthand `"2 / 3 / 4 / 5"`) is accepted as an input alias and serialized back as `grid-column` / `grid-row`.
- `grid-template-columns` / `grid-template-rows` accept a track count, an array of px numbers or `{ fr }`, or a CSS track string; explicit tracks are written back as a CSS track list.
- `flex-start` / `flex-end` are accepted aliases of `start` / `end`.

### 3. Sizing Modes
Explicit sizing is declared via `sizing: { width?, height? }` (or `width` / `height` directly); size bounds are CSS properties on the element (`min-width`, `max-width`, `min-height`, `max-height`), also accepted inside `sizing`:
- Modes: `"fixed"` (pixel), `"fit-content"` (hug content), `"max-content"` (hug without wrap), `"fill"` (expand to parent/track).
- **`%`, CSS Math & `"auto"`**: `width`, `height`, `min-width`, `max-width`, `min-height`, `max-height` accept percentages (`"50%"`), mixed-unit `calc()` / `min()` / `max()` / `clamp()` (`"calc(100% - 32px)"`, `"min(90%, 480px)"`, resolved live against the parent's content box on layout and resize), and `"100%"` (which maps to `"fill"` on an in-flow layout axis, or `"100%"` dynamic `widthExpr`/`heightExpr` in a free/`absolute` parent). `width: "auto"` / `height: "auto"` follows CSS sizing: `"fill"` when placed along a parent-stretched layout axis (for non-text elements), and `"fit-content"` otherwise (unlike Figma's fixed pixel box).
- **Container Defaults**: An auto-layout container (`display: "flex" | "grid"`) with an omitted axis defaults to `"fill"` when placed in-flow along a parent-stretched definite axis (column-flex cross axis, definite row-flex cross axis, or grid cell under `stretch`), and `"fit-content"` elsewhere. Writing an explicit pixel size on a stretched axis pins it to `"fixed"` so parent alignment does not stretch past it.
- **Text Defaults**: A text's height is measured. An omitted `height` is `"fit-content"` — inside an auto-layout parent and on a free canvas alike — so the box is the block the content occupies rather than one line; an authored `height` pins that axis to `"fixed"`, and a pinned box shorter than its block is a text-height finding. Inside an auto-layout parent an omitted `width` is also `"fit-content"` (wrapping to the parent); on a free canvas an omitted width falls back to a character estimate, so give a wrapping run a width. Single-line buttons, chips, and nav items without an explicit width should declare `sizing: { width: "max-content", height: "fit-content" }` (or `white-space: "nowrap"`) to prevent unwanted wrapping.
- **Min/Max Bounds**: top-level `min-width`, `max-width`, `min-height`, `max-height` (or `sizing.minWidth` etc.) clamp both layout-derived axes (`fill` / `fit-content`) and `fixed` / free / `position: "absolute"` elements (CSS order: `max` first, then `min`, so `min` wins on conflict).
- **Frames are not text**: a content-driven size is only computed by an Auto-Layout parent's layout pass. On a `frame` / `component` with no `display: "flex" | "grid"`, `sizing: "fit-content"` does nothing — the element keeps its authored pixel box, and one authored without `width` / `height` stays `0×0` with a `check` warning. Give the frame explicit pixel sizes, or give it Auto-Layout so the hug has something to compute it.

### What CSS has and this dialect does not
- **Positioning / flow**: `margin: auto`, normal flow, `float`, `position: fixed` / `sticky`, `z-index`, `inset` / `top` / `right` / `bottom` / `left`, `aspect-ratio`.
- **Flex / Grid**: `flex-basis`, `flex-shrink`, `flex-flow`, `order`, `align-items: baseline` / `align-self: baseline`, `grid-template-areas`, `grid-template` / `grid` shorthands, `place-items` / `place-content` / `justify-items` / `justify-self`.
- **Units**: `em`, viewport units (`vw` / `vh`), and `%` on spacing/typography/coordinates (`gap`, `padding`, `margin`, `font-size`, `x`, `y`). Box sizes (`width`, `height`, `min-*`, `max-*`) and `border-radius` support `px`, `rem`, `%`, and `calc()` / `min()` / `max()` / `clamp()`.
- **Paint / background**: `background-image`, `background-size`, `background-position`, `background-repeat`, `mask-image`, `clip-path`, `object-position` (use an image fill's `focalPoint` / `crop`).
- **Box decoration**: `outline` (use a `strokes` layer). `outline` in this dialect is a text glyph's own geometry, so a CSS ring on a shape is reported and dropped rather than silently ignored.
- **Text / CSS features**: `font` shorthand, `text-decoration-line`, `text-decoration-color`, `word-spacing`, `text-indent`, `word-break`, `oblique`, pseudo-elements, media queries, `scroll-snap` (use `scroll-behavior: "fixed" | "sticky"` on children of an overflowing container instead of CSS `position: fixed / sticky`).

### What this dialect has and CSS does not
`component` / `variant` / `instance` with restricted `overrides`, `cornerSmoothing` (squircle), text on a path, `ellipse` arcs (`sweep` / `startAngle` / `innerRadius` / `gap`), `polygon` / `star` primitives, liquid glass, procedurally generated edge breaks (`tear`: torn, scallop, zigzag), slide transitions, multi-page documents, sibling masking, per-element `mix-blend-mode` + per-layer `blendMode` + `opacity`, a scroll position (`scroll-x` / `scroll-y`, which CSS keeps as DOM state rather than as a property).

### Silent traps
A CSS spelling can be accepted, ignored, or stored differently:
- **Text ink is `fills`.** `color` / `style.color` is a fallback, not the top paint. On a text that already has a fill, patching either is ignored; patch `fills` instead.
- **`opacity` is 0..1.** CSS percentages like `"50%"` are converted to `0.5` on load; unitless numbers `> 1` clamp to `1`.
- **A lone `border-style` or `border-*-width` draws a 1px border**, not CSS's `medium` (3px): the dialect's default for a stroke with no width is `1`, the same value `border: "#FF0000"` already gives. Write `border-width` when the weight matters.
- **A lone `text-overflow` is dropped and reported**: with no `maxLines` there is no line count to clamp, so there is nothing to ellipsize. `line-clamp` / `maxLines` must be written beside it.
- **`text-decoration` carries no colour.** `"underline #f00"` keeps the underline and drops the colour.
- **`background: "url(...)"` is a solid colour literal.** Use an image fill.
- **`fills`, `strokes` and `effects` are bottom-first; CSS strings (`background`, `boxShadow`, `textShadow`) are top-first.** `fills[0]` / `strokes[0]` / `effects[0]` paint underneath and the last entry is front-most, so hand-authored arrays written in CSS order are upside down. CSS strings (`background`, `boxShadow`, `textShadow`) use CSS order (first listed on top) and are reversed on load — which is why writing the arrays by hand is the trap, not the strings.
- **`scale` is a mirror, not a size.** `"-1 1"` / `"1 -1"` flip an axis; any magnitude other than `1` is refused and reported, because a bigger box is `width` / `height`, not a transform.
- **`line-height` numbers are unitless multipliers, not px.** `lineHeight: 1.4` means `1.4 * fontSize`. A bare number `27` on a 23px font resolves to `23 * 27 = 621px` and fails height check; a hug-height text hides that overflow, so `check` reports any bare number above `4` by name. Write `"27px"` for absolute pixels.
- **`path` commands (`d`) are stored as written.** `width` / `height` are its box, not a scale, so a `d` authored for 24×24 inside a 48px box draws in the top-left quarter. Write `viewBox: "0 0 24 24"` and normalize bakes the scale into `d` once — the key itself is not stored, so `d` is still the raw geometry afterwards. Without it, author `d` in the target size (or generate via `./tools/fish assets icon <file.svg> --size N` / `--source lucide --size N`). Scaling a 24×24 outline icon down to `12`–`16px` keeps visual Lucide proportion only when `strokes[].width` scales proportionally (`strokeWidth * (size / 24)`), because `viewBox` baking scales geometry without mutating strokes. Resizing the LAYER — a canvas drag, the Scale tool, or `apply` patching `width`/`height` — bakes the factor into `d` as well, so patch a path's box instead of hand-transforming its commands. A `d` that covers under a third of its box is reported as an `info`, because an outline left behind by a box edit is otherwise invisible.
- **A top-level frame's name is editor chrome, not artwork.** The canvas paints it above the frame while you edit; no export and no `?view=canvas` render carries it. Wrapping a design in an extra artboard frame to hide the name changes nothing — and the name is still editable in the Layers panel.

## Layout Guides

Editor-only rulers drawn over `frame` and `component` nodes (`layoutGuides`; layout ignores them, never exported/shown in `?view=canvas`, snaps drags/draws inside that frame only). `componentSet` and `instance` reject guides (reported, not dropped quietly).

```jsonc
"layoutGuides": [
  { "kind": "columns", "count": 5, "align": "stretch", "gutter": 20, "margin": 0, "color": "#FF00001A" },
  { "kind": "rows",    "count": 3, "align": "start", "height": 96, "gutter": 16, "margin": 40 },
  { "kind": "grid",    "size": 8, "color": "#0000000D", "visible": false }
]
```

| key | applies to | meaning |
|---|---|---|
| `kind` | all | `columns` \| `rows` \| `grid` (required). |
| `count` | columns, rows | Number of bands (required). Grid derives count from box. |
| `align` | columns, rows | `start` \| `center` \| `end` \| `stretch` (default `stretch`). |
| `width` / `height` | columns / rows | Band size; required unless `align: "stretch"`. |
| `size` | grid | Cell size (required). |
| `gutter` | columns, rows | Gap between bands (default `0`; ignored by `grid`). |
| `margin` | columns, rows | Axis inset: both ends for `stretch`, starting edge only (`left`/`top`) for `start`/`center`/`end` (default `0`; ignored by `grid`). |
| `color` | all | `#RRGGBB` / `#RRGGBBAA` (default `#FF00001A`). |
| `visible` | all | `false` hides guide (default drawn). |

Saved `layoutGuide` styles (`doc.styles[]`, `guides: LayoutGuide[]`) copy by value when applied.

## Paints, Strokes & Fills

- **Fill Stack**: `fills: [...]`. Stored **BOTTOM-FIRST** (`fills[0]` paints underneath, last paints on top). An explicit `fills: []` means transparent/no fill. Text ink is its `fills` stack (default black if omitted); `style.color` / a flat `color` is only the fallback used when no fill exists.
- **Image Fills**: An image is a **fill layer**, not an element type. Register in `doc.assets[]` and apply to any shape:
  ```json
  { "type": "image", "assetId": "asset_1", "fit": "cover", "focalPoint": { "x": 0.5, "y": 0.5 } }
  ```
  `fit` options: `"cover"` (default), `"contain"`, `"fill"`, `"crop"`.
  `crop: { x, y, scale, rotation? }` is authoritative framing for **`fit: "crop"` only** — any other `fit` ignores it without a repair. It is **not** a focal point (that is `focalPoint`, clamped to 0..1):
  - `x` / `y`: where the bitmap's **top-left** lands, in fractions of the box's own width / height. Signed, and normally negative — a centred `cover` framing already has part of the bitmap outside the box.
  - `scale`: a multiple of the scale at which the bitmap just covers the box, so `1` is "exactly covers" and `2` is twice that. It is not an absolute zoom.
  - `rotation`: degrees clockwise about the bitmap's own centre.
  To place it like CSS `object-position: fx fy` at cover scale, solve it rather than guess: with `nat` the asset's `width` / `height` and `base = max(boxW/natW, boxH/natH)`, then `scale: 1`, `x: (boxW − natW·base)·fx / boxW`, `y: (boxH − natH·base)·fy / boxH`. `crop` needs `assets[].width` / `height`: with no natural size nothing can be solved and the paint falls back to `cover`.
  `focalPoint` / `crop` / `imageCrop` may also be written at the **element** level, where they fold onto the image fill that lacks its own (a fill's own declaration wins).
  **`focalPoint` is three positions, not a continuum**: each axis resolves to start / middle / end at the 0.34 and 0.66 cutoffs, so `0.5`, `0.4` and `0.34` are all dead centre, and `0.3` is the first value that moves the framing towards the start. Aim coarser than a third of the overflow with it; for anything finer (a face off-centre in an extreme crop) use `fit: "crop"` with the `x` / `y` solved above.
- **Gradients**:
  - `linear-gradient`: `angle` (degrees, 90 = left-to-right), `stops: [{ color, offset: 0..1 }]`, or `{ from, to, fromOffset, toOffset }`.
  - `radial-gradient`: `center: { x, y }` as fractions of the box, `radius` or `rx`/`ry`, `stops`. `radius` is **not px**: it is a fraction of the box in object-bounding-box units, so `0.5` reaches the nearer edges and `0.71` the corners (`rx`/`ry` are half-axes as fractions of width / height). Everything past the radius keeps the last stop's colour, so a falloff that should end invisibly needs its last stop at `offset: 1` with a transparent colour — two stops sharing an offset is a hard band, not a glow.
  - A `stops` array is the whole ramp: `from` / `to` / `fromOffset` / `toOffset` are the two-stop shorthand and are not combined with it.
- **Pattern Fills**: a procedurally drawn tiling. No bitmap, no asset, and every motif has a closed-form CSS expression:
  ```json
  { "type": "pattern", "motif": "dots", "tile": { "width": 16, "height": 16 }, "weight": 6, "foreground": "#0F172A" }
  ```
  - `motif`: `"dots"` | `"grid"` | `"diagonal-stripes"` | `"crosshatch"` | `"checker"`. Anything else falls back to `dots` with a repair.
  - `tile`: one cell in px. `scale` multiplies it; `spacing: { x, y }` adds the gap around it. For the two stripe motifs, `tile.width * scale + spacing.x` is the stripe period measured across the stripes, and `angle` (default 45) turns them.
  - `weight`: the line width for `grid` / stripes / `crosshatch`, the dot diameter for `dots`. Clamped into the cell, so both renderers clip identically.
  - `alignment: "start" | "center" | "end"` places the tile grid on the box.
  - `foreground` is the motif; `background` fills the gaps, and omitting it means transparent.
  - `tileType: "rectangular" | "horizontal-hexagonal" | "vertical-hexagonal"` (default rectangular). The hexagonal pair repeats a doubled tile whose second copy is shifted half a cell — rows stagger for `horizontal-hexagonal`, columns for `vertical-hexagonal`. Only `dots` / `grid` / `checker` stagger; the stripe motifs have no tile to offset.
  - A `stroke` layer's `paint` may be a pattern too (`paint: { "type": "pattern", … }`), so an outline can carry the same tiling as a fill.
- **Strokes**: `strokes: [{ color, width, style: "solid" | "dashed" | "dotted", align: "inside" | "center" | "outside", side: "all" | "top" | "right" | "bottom" | "left" | "custom", dashArray: [dash, gap] }]` — a stack, bottom layer first. Always the plural: there is no singular `stroke` key, so one stroke is a one-entry stack. Per-side CSS declarations (`border-top`, `border-bottom-color`, `border-left-style`, `border-top-width`, etc.) split into multiple `strokes[]` rows whenever active sides differ in color or style (same color+style sides merge into one `sides` / `side: "custom"` row). An element-level `border` / `border-*` is CSS's border and is drawn **inside** the box (and deducted from auto-layout/child content boxes); a `strokes[]` row that says nothing about `align` keeps `center`, which is Figma's default rather than CSS's. `"dotted"` keeps `style: "dotted"` and renders round SVG dots (`0 2w` with round linecap) unless overridden by an explicit `dashArray`.
- **Corner Smoothing**: `border-radius` — `12` / `"12px"`, `"50%"` (true pill/ellipse corners relative to box dimensions), elliptical `"rx / ry"` (`"10px / 20px"`, `"50% / 25%"`), or CSS shorthands `"8px 8px 0 0"` (top-left, top-right, bottom-right, bottom-left — CSS's order); written as CSS strings while numbers and 4-tuples read back the same. Note: `50%` on a non-square `rect` produces elliptical radii (`w/2` by `h/2`), NOT a uniform clamped circular `min(w,h)/2` radius (use `9999px` for a stadium pill). The CSS corner longhands (`border-top-left-radius` and the other three, camel or kebab) are read too, and override the one corner of the shorthand they name; a corner nothing names is `0`. `cornerSmoothing: 0..1` is the squircle (iOS preset is `0.6`, disabled on elliptical radii).
- **Arcs**: `ellipse` supports `sweep` (0..360), `startAngle`, `innerRadius` (0..0.99 for donuts), `gap` (angular seam).

## Effects, Filters & Blending

- **Effects**: `effects: [{ type: "drop-shadow" | "inner-shadow" | "layer-blur" | "backdrop-blur" | "liquid-glass" | "tear", color, offset: { x, y }, blur }]`. Stored **BOTTOM-FIRST** (`effects[0]` sits underneath and the last entry is front-most; CSS `boxShadow` / `textShadow` declaration strings are top-first and reversed on load, and the Inspector lists rows top-first to match visual order).
  - `blur` is a radius in px (double Gaussian sigma). A `drop-shadow` on a `text` element paints through the glyphs (CSS `text-shadow`), so it is the ONLY shadow a text has — `"text-shadow"` is accepted as an input alias, normalized to `drop-shadow` and reported; it is not a stored type.
  - **`tear`**: geometric edge/hole silhouette clip (photos, fills, text, or frames; exports as a plain path):
    `{ type: "tear", form?: "edge" | "hole" | "scrap", profile?: "torn" | "scallop" | "zigzag", side?: "top" | "right" | "bottom" | "left", at?: 0..1 | [0..1, 0..1], scale?: 150, roughness?: 0.6, fiber?: 0, seed?: 1, inset?: N | [top, right, bottom, left] }`.
    - `form`: `"edge"` (default, replaces `side`), `"hole"` (closed loop cutout showing layers behind), or `"scrap"` (keeps only inside loop). Retired inputs `type: "edge"`, `hole: "cut"/"scrap"`, and `profile`/`type: "torn-edge"`/`"deckle"`/`"charred"` normalize with a report.
    - `side`: required when `form: "edge"` (unknown `side` drops the effect); ignored but preserved on loops.
    - `at`: break fraction along axis (`1` = named edge, `0` = far edge, pulled inward so clip stays inside box); `[start, end]` tilts linearly along that side.
    - `scale`: coarsest wavelength/pitch in px (`16–900`, default `150`; `0` = straight cut with no noise/plies).
    - `roughness` (`0–1`, default `0.6`) and `fiber` (`0–1`, default `0`): apply to `"torn"` only (stepped paper plies > 0).
    - `seed` (default `1`): deterministic (`torn` only; share seed across split sheets).
    - `inset` (`0..100` percentage, scalar or `[top, right, bottom, left]`): loop margin from each edge on `"hole"`/`"scrap"` (`0` cuts the whole box, `100` leaves no loop); default derives from tear reach so the loop stays inside the box. Multiple edge tears and holes compose cleanly.
  - **`liquid-glass`**: Apple/Figma-style realistic glass material with edge refraction and rim lighting:
    `{ type: "liquid-glass", frost?: 10, refraction?: 70, depth?: 20, dispersion?: 22, lightAngle?: -35, lightIntensity?: 45, splay?: 20 }`.
    - `frost`: blur radius in px (0–100, default 10).
    - `refraction`: edge distortion percentage (0–100, default 70).
    - `depth`: curved edge inward reach in px (1–100, default 20, capped at 50% short side).
    - `dispersion`: chromatic aberration split (0–100, default 22).
    - `lightAngle`: light incidence angle in degrees (-180–180, default -35°, 0 = top).
    - `lightIntensity`: rim highlight brightness (0–100, default 45).
    - `splay`: spread of rim light across the surface (0–100, default 20).
    All fields are optional and default to Apple iOS material calibration.
- **Color filter**: image fill `fills[].adjust` (`image layer only`) — this is the only surface the inspector offers, so an image's look goes on its fill layer. Element-level `adjust` is import-only (CSS `filter`), renders, and cannot be edited in the app.
  Supports: `exposure`, `brightness`, `contrast`, `saturation`, `temperature`, `tint`, `highlights`, `shadows`, `hueRotate`, `invert`, `grayscale`.
- **Masking**: `isMask: true` on an element masks subsequent siblings in the container. `mask-mode: "alpha" | "luminance"`. `mask-invert: true` reads the luminance as its negative, so dark pixels reveal and bright ones hide — `luminance` mode only; it is ignored in `alpha` mode.
- **Lock**: `locked: true` prevents canvas selection; pointer events pass through.
- **Blend mode**: `normal` (default), `darken`, `multiply`, `color-burn`, `lighten`, `screen`, `plus-lighter`, `color-dodge`, `overlay`, `soft-light`, `hard-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`. Accepted per element (`mix-blend-mode`) or per paint layer.

## Typography, Spans & Text-on-Path

- **Text Style**: write standard CSS text properties at the element level — `font-family`, `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `font-variant-numeric`, `text-align`, `vertical-align`, `text-transform`, `text-decoration`, `line-clamp`, `text-overflow`, `text-shadow`. `white-space: "nowrap"` is a width statement: it measures the text as `max-content`, and an authored `width` still wins. A `text-shadow` STRING is an input alias: normalize converts it into `drop-shadow` entries in `effects[]` and drops the string, so the shadow can then be edited like any other.
- **A box taller than its line is TOP-aligned.** `vertical-align` is the only key that moves a line block inside its own box (`top` default, `middle`, `bottom`), and it places the block, not the glyphs: a generous box on a hug-height label costs nothing, while the same slack on a badge, a glyph in a circle or a seal's numeral falls entirely below the text and reads as "sitting high". State the claim — `vertical-align: "middle"` — when the slack was meant to be split; `--audit` grades the result only when the file claimed it. Getting the optical centre exactly right can still want a pixel or two of nudge, because a line box carries descender space the glyphs do not fill: author, render, and move the box rather than the text.
- **Vertical text**: `writing-mode: "vertical-rl" | "vertical-lr"` (or `sideways-rl` / `sideways-lr`) on a text element is folded onto `rotation: 90` with the box's axes swapped about its centre — a `12 × 240` column becomes a `240 × 12` line in the same place, so the HTML importer and a hand-written document produce the same editable element. Upright vertical type (`text-orientation: "upright"`, or CJK under the default `mixed`) is reported, not turned; on a non-text element `writing-mode` is reported and dropped.
- **Compact `style` string**: `style: "700 24/1.2 Inter #FFFFFF"` expands to the same object — tokens in any order: a weight (a bare 100–900 counts as one only when a second size token follows), `<size>[/<lineHeight>]`, a colour, a family, `left|center|right|justify`, `top|middle|bottom`, `uppercase|lowercase|capitalize`, `italic`, `underline|line-through`, `tabular-nums`, `ls=<px>`. A family may contain spaces: unquoted words are joined back together, and quotes make it explicit — `"600 28 \"SF Pro Display\""` and `"600 28 SF Pro Display"` both yield `fontFamily: "SF Pro Display"`. Quote the family when one of its words is a token (`"SF Pro Display Bold"` keeps `Bold` in the name; unquoted it is read as `fontWeight`).
- **Fonts travel only if you make them**: the canvas resolves `fontFamily` from the machine it runs on, so store the family you mean — the editor writes the bare name (`"Inter"`) and defaults to `"system-ui"` — and declare fonts with `src` in document-level `fonts[]` for SVG export. A stack carrying its own generic (`"Inter, sans-serif"`) is still honoured, and reads to `fish check` as "the substitution is intentional"; a bare family is a claim the file cannot keep on another machine. See §Fonts.
- **Text colour is `fills`, not `style.color`.** The stored ink is the `fills` stack; `style.color` / a flat `color` is only the fallback when the text has no fills. A **text style declares type, and only type**: `doc.styles[]` with `styleType: "text"` may carry `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `lineHeight`, `letterSpacing`, `textDecoration`, `textTransform` and `tokenBindings` — nothing else. `color` (ink is the layer's fills), `align` / `verticalAlign` (they place the box), `fontVariantNumeric`, `maxLines` / `textOverflow` are the layer's; normalize drops an authored one from a style and reports it. The style editor and the layer inspector read the same list, so a parameter is never editable in two places. See §Silent traps.
- **Spans**: `spans: [{ text: "...", style: { color?: "#RRGGBB", fontFamily?, fontSize?, fontWeight?, fontStyle?, letterSpacing?, textDecoration? } }]`. `style` is an object, not a CSS declaration string; colour belongs inside it (`style.color`), and a run colour is literal — never put `tokenId` on a span. Writing `$token` or `var(--name)` inside `spans[].style` (`color`, `fontSize`, `letterSpacing`) materialises the token's value in the element's active modes at load/op time; for persistent colour token tracking, put `tokenId` on the text element's `fills[]`. Inline HTML shorthand in `content` (`<b>Bold</b> <span style="color: #3B82F6">Blue</span>`) is parsed only when `spans` is absent.
- **Text on Path**: `onPath: { pathId: "shape_id", startOffset: 0..100, side: "out" | "in" }`.

## Components & Instances

- **When to use**: if the same structure appears more than once (button, card, nav item, list row, badge), make it a master and place instances. Duplicating the frame is a copy, not a system: a later change costs N edits instead of one.
- **Masters**: Defined as `type: "component"` (or grouped inside `componentSet` with `variantProperties`).
- **Where a master lives**: a master is a canvas element and paints where it sits, so put every master on one dedicated page (`Components`, last) and exclude that page from visual grading with `check --skip-page` — see `workflow.md` §3 "Where masters live". Instances resolve across pages; the page a master sits on is a placement choice, not a scope.
- **Instances**: `type: "instance"`, referencing master via `componentId`. Overrides apply sparsely to master nodes.
- **Instance Element vs. Overrides**: An instance is a first-class canvas element in its own right. Transforms (`rotate`, `scale`, `transform`), placement (`x`, `y`, `position`), opacity, and instance-level styling (`fills`, `strokes`, `border-radius`, `overflow`, `instanceScale`) belong directly on the instance element itself (e.g. `{ type: "instance", componentId: "icon-arrow", rotate: "90deg" }`). By contrast, `overrides[]` targets specific child layers inside the master component.
- **Instance Box**: An instance carries its own `width` / `height`. An OMITTED axis is copied from the master at load; an explicit `0` stays `0` and paints no background, stroke or padding (only its children show). Use `sizeOverride: true` when the instance must keep a box that differs from the master.
- **Hugging & Stretchable Masters**: If the master's axis is `fit-content` / `max-content`, the instance re-derives that axis from content and IGNORES its stored number. Pin a different instance size with `sizeOverride: true` (or declare that axis's `sizing` on the instance). When an instance must stretch horizontally or vertically inside an Auto-Layout parent (`sizing: { width: "fill" }` or `alignItems: "stretch"`) and its children (like a progress bar fill or fluid card header) must stretch with it, give the **master itself** `display: "flex"` with child `sizing: "fill"`; a free-placed master (no `display`) scales only its outer box while leaving fixed-pixel children behind. This is how one master serves Standard / Tall / Responsive instances without a second master.
- **Overrides are sparse**: override only what differs inside the master (text, image, fill); leave everything else inherited. Child geometry inside the master (coordinates, rotation) is locked to preserve component integrity. A reset (`reset-instance`) is cheaper than maintaining a near-copy.
- **Allowed Overrides**: `overrides[].property` is restricted to: `content`, `style`, `spans`, `fills`, `strokes`, `effects`, `adjust`, `borderRadius`, `cornerSmoothing`, `blendMode`, `link`, `visible`, `opacity`, `fillEnabled`, `assetId`, `locked`, `overflow`, `componentId`, `fillStyleId`, `strokeStyleId`, `textStyleId`, `effectStyleId`, `tokenBindings`, `themeMode`, `numberMode`, `scrollX`, `scrollY`, `scrollBehavior`.
- Presence dictates inheritance: an absent property inherits master changes; an explicitly defined property (e.g. `fills: []`) overrides. The box follows the same rule at load — an omitted axis is copied from the master, an explicit `0` is kept.
- **Capability boundaries** — three, and each one answers "no" rather than doing something approximate:
  - **A master must live in the same document.** `componentId` has to name a `type: "component"` node (a `componentSet` member counts). A dangling id, or one pointing at a `frame`, paints a dashed empty box; `fish check` reports it. There is no cross-file reference, because the file has to stand alone.
  - **An instance has no children.** Its subtree exists only as a RESOLUTION of the master, so "add a layer inside the instance" is not a thing you can write — the write belongs on the master, or the instance has to be detached first. What you can write is an override on a master node, and nesting is addressed with a `/` path (`slot/dot` = the `dot` inside the `slot` instance). Resolution is recursive; a chain of distinct masters deeper than 32 crossings stops expanding and paints the instance's own box.
  - **An override names a master NODE, and survives a swap by LAYER NAME.** `overrides[].targetId` is the node id inside the current master. Switching `componentId` re-points the override onto the new master's layer with the same `name` (same occurrence, if two share one), and keeps it only when both masters started from the same value for that property — a change made against a different base is dropped, not applied.

## Fonts, Assets, Links & Slides

- **Fonts**: `fonts: [{ family, src?, weight?, style? }]`. The interactive canvas resolves fonts locally from the host machine; `exportCanvasSvg` emits an `@font-face` for each entry carrying a `src`. `fish check` reports any font family not declared in `fonts[]`; adding `, sans-serif` tells it substitution is intentional. **A system face is declared the same way** — `"PingFang SC, sans-serif"`, `"SF Pro Display, sans-serif"`, `"Microsoft YaHei, sans-serif"`. There is no `local` / `system` flag: naming the generic fallback IS the statement "this family comes from the machine, and this is what to use when it is absent", which is also what silences `--strict-assets`. Embed a `src` only when the exact face must travel.
- **Assets**: `assets: [{ id, name, uri, width?, height?, credit? }]`. Bitmap fills point to asset IDs. Sourcing photos and icons, link-vs-embed, licences and the 4K image ceiling are in `assets.md`. In authoring JSON, an asset may declare `file: "./assets/x.avif"`; `./tools/fish compose` resolves and inlines it into `uri` automatically so re-composing never drops assets.
- **Links**: `link: "https://..."` opens in new tab on presentation click or exported SVG `<a>`.
- **Presentations**: Slides are top-level frames, components, component sets, `html` embeds and component instances in reading order; hidden or zero-area ones are skipped, and each slide paints only its own root. A page with no slide host presents as one slide holding everything on it. A slide's transition describes leaving it into the next slide (Figma Slides parity): `slide: { transition: "none" | "dissolve" | "push" | "slide" | "morph", durationMs: 600, easing: "ease-in-out", direction: "right" }`. `slide` is read on those five types only; on any other element it is dropped with a repair. `morph` matches layers by name between this slide and the next.

## Inspection & Verification APIs

**Headless URL protocol** (used by `chrome --headless --dump-dom "file://...?report=1"` and `./tools/shot.sh`):
- `?view=canvas`: viewport-uncull artboard render (`&page=<id>` targets a page).
- `?report=1&page=<id>&element=<id>&scale=N`: emits `<script id="fish-report">` JSON with `repairs`, `validate`, `layout` (ignored auto-layout coords), and cropped `element` bounds.

**Runtime bridge (`window.__fish`)** when open in a browser:

| Member | Type / Signature | Description |
| :-- | :-- | :-- |
| `id` | `string` | Current document ID. |
| `options` | `object` | Workbench viewer options. |
| `doc` | `DesignDocument` | Live design document state. |
| `normalize(candidate)` | `(doc) => { document, repairs }` | Normalizes candidate JSON and returns repairs. |
| `validate()` | `() => [{ level, message, elementId }]` | Semantic validation diagnostics. |
| `check(options?)` | `(opts) => CheckReport \| Promise<CheckReport>` | Returns `{ ok, counts, lossyRepairs, findings, repairs, failReason, geometry?, ink? }` (`source`: `normalize`/`validate`/`geometry`/`ink`). `{ doc }` checks authored JSON; `{ ink: true }` runs DOM text-ink audit on open page (returns Promise; cannot combine with `{ doc }`). |
| `measure(id)` | `(id) => Box \| null` | Canvas coordinates & bounds of element. |
| `measureAll()` | `() => Box[]` | Bounds for all elements. |
| `layoutDebug()` | `() => [{ id, box, childrenBox, delta, overflow }]` | Computes layout container deltas and overflow. |
| `exportCanvasPng(options?)` | `(opts) => Promise<string>` | Exports artboard/selection to PNG data URL. |
| `exportCanvasSvg(options?)` | `(opts) => Promise<string>` | Exports artboard/selection to SVG markup. |

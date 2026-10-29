# FISH DSL Reference

This reference is for agents authoring FISH single-file HTML documents (`*.fish.html`): the document model, tokens and styles, element primitives, CSS deltas, paint, typography, components, and the traps that do not announce themselves.

## Reference & Canonical Schema

Inspect `templates/blank.fish.html` for the container shape.

Three layers, in order of authority:

1. **`fish check` / the normalizer** — the executable truth.
2. **`tools/fish.schema.json`** — the published contract for accepted keys and enums. It is descriptive, not the runtime validator.
3. **This document** — usage, CSS deltas and traps. It is not an exhaustive field list; if it disagrees with the schema or the engine, the schema/engine wins and this file is the bug.

## Verification & CLI Tooling

Verify structural integrity, layout geometry, and visual rendering with the kit CLI:

```bash
./tools/fish import page.html --out design.fish.html # HTML page → editable design (the fastest way in; see "HTML In" below)
./tools/fish brief design.fish.html           # Inspect styles (binding counts + literal gaps), components, fonts, assets
./tools/fish compact design.fish.html         # Emit compact JSON without HTML runtime shell
./tools/fish assets design.fish.html          # List doc.assets[]
./tools/fish assets search "coffee" --source openverse --add-to design.fish.html --embed --to hero # Search & embed photography (--to fills an element in the same run)
./tools/fish assets import ./hero.jpg design.fish.html --name Hero --to hero_rect # Local file → embedded asset (the only path for local files), filled in one step
./tools/fish check design.fish.html           # Validate schema & diagnostics (Node, no browser)
./tools/fish check design.fish.html --geometry # Verify layout bounds, overflow & clipped nodes
./tools/fish check design.fish.html --audit   # Measure the GLYPHS in a headless browser: alignment, ink centring, group alignment, empty boxes
./tools/fish check design.fish.html --audit --audit-tolerance 3 # Same, graded at 3px instead of 1px (graphic layouts)
./tools/fish check design.fish.html --strict  # Strict mode: fail on design warnings too
./tools/fish check design.fish.html --strict-assets # Strict assets: fail on any asset still left as a URL
./tools/fish apply ops.json design.fish.html  # Apply macro-ops in place (--compact supported)
./tools/fish compose design.json templates/blank.fish.html --out design.fish.html # Assemble JSON into shell
./tools/fish export design.fish.html --out out.png                                 # Headless raster PNG export
./tools/shot.sh design.fish.html out.png --element hero-title --scale 2            # Capture element + out.report.json diagnostics
./tools/shot.ps1 design.fish.html out.png -Element hero-title -Scale 2             # Same on Windows (PowerShell)
```

### HTML In — Seed vs Embed

Two ways HTML enters a document, and only one of them produces something you can edit:

- **`fish import page.html --out design.fish.html` — the primary way in.** A real browser renders the page and the layout is measured, so flex, grid, wrapping and font metrics come out as the page actually shows them — not from re-parsing CSS. The result is an **ordinary editable `*.fish.html`**: every element is a normal DSL element, `fish apply` edits it, `fish check` verifies it, and from then on THIS file is the source. The command prints what survived the trip (`elementCount`, `maxDelta`, `downgraded`, `unmapped`, missing assets) — read it before assuming the page came across whole. Known deltas: a fixed viewport (media queries are not expressed), baked coordinates where auto-layout could not be recovered (listed under `downgraded`), and remote assets that must be fetched with `fish assets`.
  - **HTML is a seed, never a round-trip.** After importing, iterate with `fish apply` on the document. Re-importing the page after edits discards them — there is no merge, so never re-run `import` to "update" a document you have changed.
  - **The page's `id` attributes become the element ids.** Write `id="hero_img"` and that is the handle afterwards: `fish assets import ./hero.jpg design.fish.html --to hero_img`, `{"op": "patch", "targetId": "hero_img", ...}`. Uniqueness is document-wide, so an id the target document already holds is not reused — that element mints its own and the import report names it under `unmapped`, as it does for characters an id cannot carry (`A-Za-z0-9_-` survive).
- **`type: "html"` embed — view-only, niche.** An `HtmlEmbedElement` frames a live page (`src`) or inlines one (`srcdoc`) as an iframe on the canvas, with a `posterAssetId` snapshot for resting state. You can look at it; nothing inside it is a FISH element, so nothing inside it can be selected, styled, or edited. Use it only to show a reference page beside your work. When the goal is a design you can keep editing, use `fish import`.

### Layout Geometry Diagnostics (`check --geometry`)
- **overflow**: In-flow child extends beyond container content box (commonly caused by text lacking a width mode).
- **clipped**: a child's painted box — turn included, so a vertical label is measured by the column it occupies — is cut by a parent with `clipContent: true`.
- **zero-size**: Container with children and paint collapsed to 0px on an axis (`warning`).
- **unused-space** (`info`): the mirror of overflow — a container that stacks downwards ends well short of a fixed height it was given, which is usually a pixel height written where `hug` was meant.

These are measurements, not verdicts: each names the DSL way to say "I meant that", and only `zero-size` is a warning. Runs in Node, no browser.

### Text Ink Audit (`check --audit`)
`--geometry` can be satisfied by a page whose every label is pinned to the left edge of its box: nothing in the document is wrong, only the picture. `--audit` opens the file in a headless browser and measures the glyphs. It needs a browser and a shell built with the report channel (rebuild `blank.fish.html`); a shell without it reports `NOT RUN`, never "0 findings".

- **align-not-applied** / **vertical-align-not-applied**: the file asks for one alignment and the computed style returns another. This is read from the RAW `#design-doc` block, so it still fires when normalization — not the renderer — is what ate the value. The vertical axis is stored as `vertical-align` and painted as `justify-content` on the line container, so the two are compared through one map (`middle` ↔ `center`, `top` ↔ `flex-start`) rather than literally.
- **ink-not-centred** / **ink-not-right** / **ink-not-centred-y**: the alignment was applied and the glyphs still miss the box centre / right edge / vertical centre by more than 1px. Legal CSS that produces the wrong frame: a container narrower than the box, a transform that moved the line, tracking the browser reserves but the ink does not fill. The y rule is gated on the file: it fires only when the layer CLAIMED the middle, because a box taller than its line is top-aligned by default and that is a legitimate document.
- **group-not-centred** (`warning`): a label does not share a centre with the icon beside it. "Beside" is a stated relationship, not a nearest-neighbour search: the two boxes must be on one line, within a gutter of each other horizontally, comparable in height, and not a layer covering half the parent — a full-bleed texture is a sibling of everything and a partner of nothing. When no sibling qualifies, the parent is used instead, and only if it declares `align-items: center`.
- **no-ink**: the box holds text and paints none of it.
- A `textPath` has no line box and is reported as skipped, with the reason. Empty text boxes are skipped silently: a spacer is a legitimate box.
- **The default grade is 1px.** On a poster or a cover that is tighter than the intent — `--audit-tolerance N` grades at N canvas px (0.25–16, scaled to screen px by the measured zoom) when a pixel is not the unit you are working in.

### Headless Protocol
- `?view=canvas`: Viewport-uncull artboard render.
- `?report=1&element=<id>&scale=N`: Emits `<script id="fish-report">` with `repairs`, `validate`, `element` bounds.
- Use `chrome --headless --dump-dom "file://...?report=1"` or `./tools/shot.sh` to read reports.
- **Never regex-replace `*.fish.html` manually.** Only modify `#design-doc` (and `#fish-assets` when present). The runtime blocks `#fish-rt-css`, `#fish-rt` and inline loader must remain untouched.

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
- **Variables & Math**: `variables: { "--color": "#FFF" }` resolves `var(--color, fallback)`. Length values support px, bare numbers, `rem` (16px), and constant `calc()` / `min()` / `max()` / `clamp()`.
  This is **authoring-time substitution only** — `var()` is folded into the value on load and creates no style. A reusable, mode-aware value is a design token; see [Design Tokens & Styles](#design-tokens--styles).
- **Pages**: A page holds its tree in `children`, and that is the only place it lives: `pages: [{ id, name, canvas, children }]` + `activePageId`. A single-page document may instead carry a top-level `elements` array; the reader adopts it into page 1 and never writes it back, so prefer `pages`.
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
- **There are no alias tokens** (`--a: var(--b)`). Express one with a style that follows a token.

**Referencing** (the value stays materialised beside the id; the engine rewrites it in the same commit when the token changes):

| Field | Points at | Use |
| :-- | :-- | :-- |
| `fills[].tokenId` | colour token | One paint layer follows the token. |
| `fills[].stops[].tokenId` | colour token | One gradient stop follows the token; `color` stays materialised beside it. Editing that colour detaches the stop. |
| `strokes[].tokenId` / `strokes[].paint.tokenId` | colour token | Stroke colour follows the token. |
| `effects[].tokenId` / `effects[].tokenBindings` | colour token / number token | Shadow colour or radius follows the token. |
| `tokenBindings: { prop: tokenId }` | number token | `borderRadius`, `gap`, `padding`, `strokeWidth`, `fontSize`, `letterSpacing`, `width`, `height`. |
| `fillStyleId` / `strokeStyleId` / `effectStyleId` / `textStyleId` | a style id | The layer uses that named style; the engine copies its values in — naming it is enough, do not spell the same declarations out on the layer as well. |

- **Modes** are token configuration, not a second set of styles. See [Modes](#modes).
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
| `componentSet` | `children`, `name`, `variantGroupProperties` | Container for component variants. Holds `component` children only. |
| `instance` | `componentId`, `width`, `height`, `sizeOverride`, `overrides` | Renders master subtree; carries no `children`. `componentId` must point at a `type:"component"` node — a `frame` is not a master and renders as a dashed empty box. An omitted width/height is copied from the master. |
| `text` | `content`, `style`, `spans`, `onPath` | Text element. Glyphs paint via `fills` (default black). |
| `rect` | `fills`, `strokes`, `border-radius`, `cornerSmoothing` | Rectangle / card shape. `cornerRadius` is an alias. |
| `ellipse` | `fills`, `strokes`, `sweep`, `startAngle`, `innerRadius`, `gap` | Ellipse, pie slice, donut, gauge. |
| `polygon` | `sides` (3..24), `cornerRadius`, `cornerSmoothing`, `fills`, `strokes` | Regular polygon. |
| `star` | `points` (3..24), `innerRadius` (0..0.99), `cornerRadius`, `cornerSmoothing`, `fills`, `strokes` | Regular star. `points` counts spikes. |
| `path` | `d`, `fills`, `strokes`, `fillRule` | Freeform vector path. |
| `line` | `dx`, `dy`, `strokes` | Line segment from `(x, y)` to `(x+dx, y+dy)`. |
| `arrow` | `dx`, `dy`, `strokes` | Vector arrow with head at `(x+dx, y+dy)`. |
| `video` | `assetId`, `autoplay`, `loop`, `muted`, `controls`, `border-radius` | Embedded or external video player. |
| `html` | `src` or `srcdoc`, `border-radius` | Embedded web page. Dropped on static PNG/SVG export. |

## CSS-Diff (How FISH Differs From Standard CSS)

FISH reads a fixed subset of CSS. This document names the common surface and the known deltas; it is not an exhaustive key list. The authoritative accepted surface is the normalizer and `tools/fish.schema.json`; when unsure, run `fish check`, which reports an unknown property instead of guessing.

**Spelling.** Write a property the way CSS spells it (`grid-column`) or the way JavaScript does (`gridColumn`) — both are read, and so are `border-radius` / `borderRadius` alike. A key in `snake_case` is refused by name. A declaration the engine cannot carry is reported as a dropped property; nothing is accepted and then quietly ignored.

### 1. Coordinates & Box Model
- **Local Coordinate Convention**: Top-level artboards sit at canvas `(x, y)`. All children of `frame` and `component` use **local coordinates relative to parent top-left `(0, 0)`**. Moving a parent never alters child coordinates.
- **In-Flow Children**: Children inside an auto-layout container (`display: "flex"` or `"grid"`) have their positions computed automatically; authors can set `(0, 0)` or omit `x`/`y`.
- **Absolute Positioning**: `position: "absolute"` takes a child out of auto-layout flow. Requires explicit `x`, `y`, `width`, `height`. Always write `position` (`layoutPosition` and `layoutAlignSelf` / `layoutMargin` / `layoutCell` are pre-rename keys the dialect **refuses** — they are dropped with a repair, not migrated).
- **Box Sizing**: Always **border-box** (`box-sizing: content-box` is not supported).
- **Transforms**: write them as CSS — `rotate: "45deg"` (clockwise around the element centre), `scale: "-1 1"` to mirror horizontally / `"1 -1"` vertically, `transform: "rotateX(20deg)"` for the 3D tilt. `perspective` (px, default 800) sets the projection depth. These are baked to bitmap on export.
- **Constraints**: For absolute or plain-frame children: `constraints: { horizontal: "left" | "right" | "center" | "stretch" | "scale", vertical: "top" | "bottom" | "center" | "stretch" | "scale" }`.

### 2. Auto-Layout (Flex & Grid)
Keys are stored flat on the container using CSS names. A nested `layout` object or a compact `layout` string is not read: write `display` plus the flat keys. Only these points differ from standard CSS:
- `display: "flex" | "grid"`; omit or use `"none"` / `"block"` for free placement.
- `gap`, `row-gap`, `column-gap`, `padding`, `margin` take a number, a tuple, or a CSS shorthand string; the file writes the shorthand.
- `align-items` on a grid container is cell alignment; `align-content` is the line axis.
- `align-self` overrides the parent's `align-items`. A positive `flex-grow` implies `sizing` fill along the parent's main axis.
- `grid-area` is stored as `{ column, row, columnSpan, rowSpan }`; `grid-column` / `grid-row` accept CSS line ranges and are written back as `grid-area`.
- `grid-template-columns` / `grid-template-rows` accept a track count, an array of px numbers or `{ fr }`, or a CSS track string; explicit tracks are written back as a CSS track list.
- `flex-start` / `flex-end` are accepted aliases of `start` / `end`.

### 3. Sizing Modes
Explicit sizing is declared via `sizing: { width?, height? }`; size bounds are CSS properties on the element (`min-width`, `max-width`, `min-height`, `max-height`), also accepted inside `sizing`:
- Modes: `"fixed"` (pixel), `"fit-content"` (hug content), `"max-content"` (hug without wrap), `"fill"` (expand to parent/track).
- **Text Defaults**: Inside an auto-layout parent, text defaults to `fit-content` (wraps to parent width). Single-line buttons, chips, and nav items must declare `sizing: { width: "max-content", height: "fit-content" }` to prevent unwanted wrapping.
- **Min/Max Bounds**: top-level `min-width`, `max-width`, `min-height`, `max-height` (or `sizing.minWidth` etc.) clamp derived axes (`fill` / `fit-content`).
- **Frames are not text**: a content-driven size is only computed by an Auto-Layout parent's layout pass. On a `frame` / `component` with no `display: "flex" | "grid"`, `sizing: "fit-content"` does nothing — the element keeps its authored pixel box, and one authored without `width` / `height` stays `0×0` with a `check` warning. Give the frame explicit pixel sizes, or give it Auto-Layout so the hug has something to compute it.

### What CSS has and this dialect does not
- **Positioning / flow**: `margin: auto`, normal flow, `float`, `position: fixed` / `sticky`, `z-index`, `inset` / `top` / `right` / `bottom` / `left`, `aspect-ratio`.
- **Flex / Grid**: `flex-basis`, `flex-shrink`, `flex-flow`, `order`, `align-items: baseline` / `align-self: baseline`, `grid-template-areas`, `grid-template` / `grid` shorthands, `place-items` / `place-content` / `justify-items` / `justify-self`.
- **Units**: `em` and `%` lengths (px, `rem`, and the constant `calc()` family only).
- **Paint / background**: `background-image`, `background-size`, `background-position`, `background-repeat`, `mask-image`, `clip-path`, `object-position` (use an image fill's `focalPoint` / `crop`).
- **Box decoration**: `outline` (use a `strokes` layer). `outline` in this dialect is a text glyph's own geometry, so a CSS ring on a shape is reported and dropped rather than silently ignored.
- **Text / CSS features**: `font` shorthand, `text-decoration-line`, `text-decoration-color`, `word-spacing`, `text-indent`, `word-break`, `oblique`, pseudo-elements, media queries, scrolling.

### What this dialect has and CSS does not
`component` / `variant` / `instance` with restricted `overrides`, `cornerSmoothing` (squircle), text on a path, `ellipse` arcs (`sweep` / `startAngle` / `innerRadius` / `gap`), `polygon` / `star` primitives, liquid glass, procedurally generated edge breaks (`edge`: torn, scallop, zigzag), slide transitions, multi-page documents, sibling masking, per-layer `blendMode` + `opacity`.

### Silent traps
A CSS spelling can be accepted, ignored, or stored differently:
- **Text ink is `fills`.** `color` / `style.color` is a fallback, not the top paint. On a text that already has a fill, patching either is ignored; patch `fills` instead.
- **`opacity` is 0..1.** `"50%"` is read as 50 and clamped to 1.
- **A lone `border-style` or `border-*-width` draws a 1px border**, not CSS's `medium` (3px): the dialect's default for a stroke with no width is `1`, the same value `border: "#FF0000"` already gives. Write `border-width` when the weight matters.
- **A lone `text-overflow` is dropped and reported**: with no `maxLines` there is no line count to clamp, so there is nothing to ellipsize. `line-clamp` / `maxLines` must be written beside it.
- **`text-decoration` carries no colour.** `"underline #f00"` keeps the underline and drops the colour.
- **`background: "url(...)"` is a solid colour literal.** Use an image fill.
- **`line-height` numbers are unitless multipliers, not px.** `lineHeight: 1.4` means `1.4 * fontSize`. A bare number `27` on a 23px font resolves to `23 * 27 = 621px` and fails height check. Write `"27px"` for absolute pixels.
- **`path` commands (`d`) do not auto-scale to `width`/`height`.** Unlike SVG `<svg viewBox="0 0 24 24">`, a `path` element's `d` attribute defines raw coordinates; `width` and `height` are its bounding box, not a viewBox scale. Author `d` directly in the target size.
- **A top-level frame's name is editor chrome, not artwork.** The canvas paints it above the frame while you edit; no export and no `?view=canvas` render carries it. Wrapping a design in an extra artboard frame to hide the name changes nothing — and the name is still editable in the Layers panel.

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
- **Strokes**: `strokes: [{ color, width, align: "inside" | "center" | "outside", side: "all" | "top" | "right" | "bottom" | "left" | "custom", dashArray: [dash, gap] }]` — a stack, bottom layer first. Always the plural: there is no singular `stroke` key, so one stroke is a one-entry stack. Per-side widths (`borderTopWidth` and friends) are element-level keys, not per-layer ones.
- **Corner Smoothing**: `border-radius` — `12` / `"12px"`, or the CSS shorthand `"8px 8px 0 0"` (top-right-bottom-left); stored as a number or a 4-tuple, so either form reads back the same. The CSS corner longhands (`border-top-left-radius` and the other three, camel or kebab) are read too, and override the one corner of the shorthand they name; a corner nothing names is `0`. `cornerSmoothing: 0..1` is the squircle (iOS preset is `0.6`).
- **Arcs**: `ellipse` supports `sweep` (0..360), `startAngle`, `innerRadius` (0..0.99 for donuts), `gap` (angular seam).

## Effects, Filters & Blending

- **Effects**: `effects: [{ type: "drop-shadow" | "inner-shadow" | "layer-blur" | "backdrop-blur" | "liquid-glass" | "tear", color, offset: { x, y }, blur }]`.
  - `blur` is a radius in px (double Gaussian sigma). A `drop-shadow` on a `text` element paints through the glyphs (CSS `text-shadow`), so it is the ONLY shadow a text has — `"text-shadow"` is accepted as an input alias, normalized to `drop-shadow` and reported; it is not a stored type.
  - **`tear`**: a break in the sheet — one side of the box, or a closed loop punched through it. Unlike the filters above it is geometry: the layer's silhouette is clipped, so it holds for a photo, a solid fill, type or a whole frame, and exports as a plain path. `profile` chooses WHICH break; every profile shares one kernel.
    `{ type: "tear", form?: "edge" | "hole" | "scrap", profile?: "torn" | "scallop" | "zigzag", side?: "top" | "right" | "bottom" | "left", at?: 0..1 | [0..1, 0..1], scale?: 150, roughness?: 0.6, fiber?: 0, seed?: 1, inset?: % | [top, right, bottom, left] }`.
    - `form` chooses what the tear is: `edge` (the default) replaces one side of the box, `hole` closes the same break into a loop and keeps the sheet around it so whatever sits behind shows through, `scrap` keeps only the piece inside that loop. `type: "edge"`, `hole: "cut"` and `hole: "scrap"` are read as the retired spellings of `tear` + `form` and reported.
    - `side` is required by the edge form and unread by the loops; an unknown side drops the whole effect rather than guessing an edge.
    - `profile` defaults to `torn`. `"torn-edge"` is accepted as an input alias for the same effect and reported, the same way `"text-shadow"` is: it is not a stored type. `"deckle"` and `"charred"` are read as `torn` too.
    - `at` places the break across its axis as a fraction of the box: `1` is the box edge the `side` names, `0` the far side, and anything between is a straight guide at that fraction. Both ends sit slightly inside the number given, pulled inward by the break's own reach, so the silhouette never leaves the box. One number is a break parallel to its side. A PAIR gives the two ends their own positions, in the order the side runs (top then bottom for a `left`/`right` break, left then right for `top`/`bottom`), and the guide is the straight run between them — that IS the tilt, and it is linear: `[1, 0.4]` on a `right` break keeps the top end on the edge and pulls the bottom end 40% of the way across, while `[0.3, 1]` is the same slope the other way up. There is no separate tilt limit, so a difference of `0.7` tilts across 70% of the box however tall it is. The break still spans the side corner to corner; only its two ends move across.
    - `scale`: wavelength of the coarsest feature in px (16–900); scales the whole break. For `scallop` and `zigzag` this IS the pitch of one scallop or tooth. `0` is not a tiny wave — it is a perfectly straight cut along the same guide, with no paper plies; every other value snaps into 16–900.
    - `roughness` (0–1, default 0.6) and `fiber` (0–1, default 0) belong to `torn` only: `roughness` is how much of the two finer octaves rides on the coarsest; `fiber` is how far the fibres stray from the break — `0` is a clean cut, anything above steps the terraced paper plies out. A `scallop` or `zigzag` carries neither.
    - `seed`: the break's identity and the determinism contract. Normalize defaults it to `1` and never rolls dice, so the same seed draws the same break on canvas, in an export and on the next machine. Two layers broken from one sheet share the seed. The periodic profiles draw no noise and ignore it.
    - `hole`: closes the break into a loop inside the sheet instead of replacing one side — the only way to put a torn sheet in FRONT of something. `"cut"` keeps the paper and knocks the loop out, so whatever sits behind shows through; `"scrap"` keeps only the piece inside it, so two layers sharing one contour are the two halves of a torn-out hole. A hole does not read `side` or `at` — its seam sits at the middle of the box's top edge, where the mirrored field turns around — but it KEEPS them, and a break keeps `inset`, so flipping between the two forms in the inspector loses nothing.
    - `inset`: a hole's margin from the box, in px — one number for all four sides, or `[top, right, bottom, left]` (CSS's order) to place the loop off-centre or give it another shape. Absent means the tear's own reach, which is what keeps a hole from swinging out through the layer's edge.
    - Two breaks on different sides compose (the clips intersect); the pieces are not bound to one `profile` and may differ. Loops compose with them the same way: two holes on one layer leave the sheet minus their union.
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
- **Masking**: `isMask: true` on an element masks subsequent siblings in the container. `mask-mode: "alpha" | "luminance"` (`maskMode` is also read; the file writes `mask-mode`). `mask-invert: true` (`maskInvert`) reads the luminance as its negative, so dark pixels reveal and bright ones hide — `luminance` mode only; it is ignored in `alpha` mode.
- **Lock**: `locked: true` prevents canvas selection; pointer events pass through.
- **Blend mode**: `normal` (default), `darken`, `multiply`, `color-burn`, `lighten`, `screen`, `plus-lighter`, `color-dodge`, `overlay`, `soft-light`, `hard-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`. Accepted per element (`mix-blend-mode`) or per paint layer.

## Typography, Spans & Text-on-Path

- **Text Style**: standard CSS text properties are accepted at the element level and folded into the stored `style`: `font-family`, `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `font-variant-numeric`, `text-align`, `vertical-align`, `text-transform`, `text-decoration`, `line-clamp`, `text-overflow`, `text-shadow`. A `text-shadow` STRING is an input alias: normalize converts it into `drop-shadow` entries in `effects[]` and drops the string, so the shadow can then be edited like any other. Inside `style`, camelCase, kebab-case and the stored aliases are equivalent: `textAlign` / `text-align` / `align`, `font-size` / `fontSize`, `line-clamp` / `maxLines`. A key inside `style` that names nothing is reported as `unknown property … is unsupported inside style` instead of being dropped in silence.
- **A box taller than its line is TOP-aligned.** `vertical-align` is the only key that moves a line block inside its own box (`top` default, `middle`, `bottom`), and it places the block, not the glyphs: a generous box on a hug-height label costs nothing, while the same slack on a badge, a glyph in a circle or a seal's numeral falls entirely below the text and reads as "sitting high". State the claim — `vertical-align: "middle"` — when the slack was meant to be split; `--audit` grades the result only when the file claimed it. Getting the optical centre exactly right can still want a pixel or two of nudge, because a line box carries descender space the glyphs do not fill: author, render, and move the box rather than the text.
- **Vertical text**: `writing-mode: "vertical-rl" | "vertical-lr"` (or `sideways-rl` / `sideways-lr`) on a text element is folded onto `rotation: 90` with the box's axes swapped about its centre — a `12 × 240` column becomes a `240 × 12` line in the same place, so the HTML importer and a hand-written document produce the same editable element. Upright vertical type (`text-orientation: "upright"`, or CJK under the default `mixed`) is reported, not turned; on a non-text element `writing-mode` is reported and dropped.
- **Compact `style` string**: `style: "700 24/1.2 Inter #FFFFFF"` expands to the same object — tokens in any order: a weight (a bare 100–900 counts as one only when a second size token follows), `<size>[/<lineHeight>]`, a colour, a family, `left|center|right|justify`, `top|middle|bottom`, `uppercase|lowercase|capitalize`, `italic`, `underline|line-through`, `tabular-nums`, `ls=<px>`. A family may contain spaces: unquoted words are joined back together, and quotes make it explicit — `"600 28 \"SF Pro Display\""` and `"600 28 SF Pro Display"` both yield `fontFamily: "SF Pro Display"`. Quote the family when one of its words is a token (`"SF Pro Display Bold"` keeps `Bold` in the name; unquoted it is read as `fontWeight`).
- **Fonts travel only if you make them**: the canvas resolves `fontFamily` from the machine it runs on, so store the family you mean — the editor writes the bare name (`"Inter"`) and defaults to `"system-ui"` — and declare fonts with `src` in document-level `fonts[]` for SVG export. A stack carrying its own generic (`"Inter, sans-serif"`) is still honoured, and reads to `fish check` as "the substitution is intentional"; a bare family is a claim the file cannot keep on another machine. See §Fonts.
- **Text colour is `fills`, not `style.color`.** The stored ink is the `fills` stack; `style.color` / a flat `color` is only the fallback when the text has no fills. A **text style declares type, and only type**: `doc.styles[]` with `styleType: "text"` may carry `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `lineHeight`, `letterSpacing`, `textDecoration`, `textTransform` and `tokenBindings` — nothing else. `color` (ink is the layer's fills), `align` / `verticalAlign` (they place the box), `fontVariantNumeric`, `maxLines` / `textOverflow` are the layer's; normalize drops an authored one from a style and reports it. The style editor and the layer inspector read the same list, so a parameter is never editable in two places. See §Silent traps.
- **Spans**: `spans: [{ text: "...", style: { color?: "#RRGGBB", fontFamily?, fontSize?, fontWeight?, fontStyle?, letterSpacing?, textDecoration? } }]`. `style` is an object, not a CSS declaration string; colour belongs inside it (`style.color`), and a run colour is literal — never put `tokenId` on a span. To bind a colour token, put `tokenId` on the text element's `fills[]`. Inline HTML shorthand in `content` (`<b>Bold</b> <span style="color: #3B82F6">Blue</span>`) is parsed only when `spans` is absent.
- **Text on Path**: `onPath: { pathId: "shape_id", startOffset: 0..100, side: "out" | "in" }`.

## Components & Instances

- **When to use**: if the same structure appears more than once (button, card, nav item, list row, badge), make it a master and place instances. Duplicating the frame is a copy, not a system: a later change costs N edits instead of one.
- **Masters**: Defined as `type: "component"` (or grouped inside `componentSet` with `variantProperties`).
- **Instances**: `type: "instance"`, referencing master via `componentId`. Overrides apply sparsely to master nodes.
- **Instance Box**: An instance carries its own `width` / `height`. An OMITTED axis is copied from the master at load; an explicit `0` stays `0` and paints no background, stroke or padding (only its children show). Use `sizeOverride: true` when the instance must keep a box that differs from the master.
- **Hugging Masters**: If the master's axis is `fit-content` / `max-content`, the instance re-derives that axis from content and IGNORES its stored number. Pin a different instance size with `sizeOverride: true` (or declare that axis's `sizing` on the instance). This is how one master serves Standard / Tall instances without a second master.
- **Overrides are sparse**: override only what differs (text, image, size); leave everything else inherited. A reset (`reset-instance`) is cheaper than maintaining a near-copy.
- **Allowed Overrides**: `overrides[].property` is restricted to: `content`, `style`, `spans`, `fills`, `strokes`, `effects`, `adjust`, `borderRadius`, `cornerSmoothing`, `blendMode`, `link`, `visible`, `opacity`, `fillEnabled`, `assetId`, `locked`, `clipContent`, `componentId`, `fillStyleId`, `strokeStyleId`, `textStyleId`, `effectStyleId`, `tokenBindings`, `themeMode`, `numberMode`.
- Presence dictates inheritance: an absent property inherits master changes; an explicitly defined property (e.g. `fills: []`) overrides. The box follows the same rule at load — an omitted axis is copied from the master, an explicit `0` is kept.

## Fonts, Assets, Links & Slides

- **Fonts**: `fonts: [{ family, src?, weight?, style? }]`. The interactive canvas resolves fonts locally from the host machine; `exportCanvasSvg` emits an `@font-face` for each entry carrying a `src`. `fish check` reports any font family not declared in `fonts[]`; adding `, sans-serif` tells it substitution is intentional. **A system face is declared the same way** — `"PingFang SC, sans-serif"`, `"SF Pro Display, sans-serif"`, `"Microsoft YaHei, sans-serif"`. There is no `local` / `system` flag: naming the generic fallback IS the statement "this family comes from the machine, and this is what to use when it is absent", which is also what silences `--strict-assets`. Embed a `src` only when the exact face must travel.
- **Assets**: `assets: [{ id, name, uri, width?, height?, credit? }]`. Bitmap fills point to asset IDs. Sourcing photos and icons, link-vs-embed, licences and the 4K image ceiling are in `assets.md`. In authoring JSON, an asset may declare `file: "./assets/x.avif"`; `./tools/fish compose` resolves and inlines it into `uri` automatically so re-composing never drops assets.
- **Links**: `link: "https://..."` opens in new tab on presentation click or exported SVG `<a>`.
- **Presentations**: Slides are top-level frames in reading order. A slide's transition describes leaving it into the next slide (Figma Slides parity): `slide: { transition: "none" | "dissolve" | "push" | "slide" | "morph", durationMs: 600, easing: "ease-in-out", direction: "right" }`. `morph` matches layers by name between this slide and the next.

## Inspection & Verification APIs

In browser contexts, `window.__fish` provides runtime inspection and verification methods:

| Member | Type / Signature | Description |
| :-- | :-- | :-- |
| `id` | `string` | Current document ID. |
| `options` | `object` | Workbench viewer options. |
| `doc` | `DesignDocument` | Live design document state. |
| `normalize(candidate)` | `(doc) => { document, repairs }` | Normalizes candidate JSON and returns repairs. |
| `validate()` | `() => [{ level, message, elementId }]` | Semantic validation diagnostics. |
| `check(options?)` | `(opts) => CheckReport \| Promise<CheckReport>` | One verdict over repairs, validation and geometry. `{ doc }` checks authored JSON; `{ ink: true }` adds the live text-ink audit and returns a promise. |
| `measure(id)` | `(id) => Box \| null` | Canvas coordinates & bounds of element. |
| `measureAll()` | `() => Box[]` | Bounds for all elements. |
| `layoutDebug()` | `() => [{ id, box, childrenBox, delta, overflow }]` | Computes layout container deltas and overflow. |
| `exportCanvasPng(options?)` | `(opts) => Promise<string>` | Exports artboard/selection to PNG data URL. |
| `exportCanvasSvg(options?)` | `(opts) => Promise<string>` | Exports artboard/selection to SVG markup. |

`check()` returns `{ ok, counts, lossyRepairs, findings, repairs, failReason, geometry?, ink? }`; every finding names its `source`: `normalize`, `validate`, `geometry` or `ink`. Any error or lossy repair fails it; warnings fail only under `strict`. An ink audit reads the painted DOM, so it cannot grade `doc` — call it on the open document without `doc`.

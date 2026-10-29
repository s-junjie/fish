---
version: alpha
name: FISH Workbench — Instrument Amber
description: >-
  The dark, docked workbench shell for FISH, a single-file vector design
  editor. Monospace instrumentation on an obsidian void, separated by hairline
  rules, lit by one amber signal colour.
colors:
  paper: "#101010"
  panel: "#181818"
  surface: "#1E1E20"
  raised: "#242428"
  field: "#242424"
  field-active: "#343434"
  inset: "#0A0A0A"
  rule: "#242428"
  rule-strong: "#333338"
  paint-row-rule: "#242428"
  paint-row-rule-open: "#4A4A52"
  ink: "#ECF3F8"
  ink-dim: "#9BA4AB"
  ink-muted: "#666C70"
  brand: "#E8A33D"
  brand-wash: "#E8A33D1F"
  brand-ink: "#2A1D08"
  brand-ink-soft: "#503813"
  selection: "#E8A33D1F"
  selection-hover: "#E8A33D2E"
  selection-subtree: "#E8A33D0A"
  selection-solid: "#31291C"
  selection-subtree-solid: "#201D19"
  selection-subtree-hover-solid: "#44351F"
  canvas-select: "#1B72FF"
  component: "#B794FF"
  snap-pink: "#FF5353"
  measure-coral: "#FF5353"
typography:
  micro:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 9px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.18em
  ui:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
  readout:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: -0.02em
  display:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.01em
  displaySm:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.01em
  row:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 10.5px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: -0.01em
  tab:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: 0.02em
  unit:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 8.5px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: 0.04em
  code:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.2
  meta:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 9.5px
    fontWeight: 400
    lineHeight: 1.2
  tag:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 8.5px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: 0.1em
rounded:
  none: 0px
  sm: 2px
  swatch: 3px
  ctl: 4px
  pill: 6px
  panel: 9px
  dock-ctl: 10px
  dock: 14px
  full: 9999px
spacing:
  hairline: 1px
  base: 4px
  grid: 8px
  rail-footer: 26px
  rail-right: 288px
components:
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "{spacing.base}"
  panel-header:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.tab}"
    height: 40px
  tab:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.tab}"
    rounded: "{rounded.none}"
    padding: 12px
  tab-active:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
  layer-row:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-dim}"
    typography: "{typography.row}"
    rounded: "{rounded.ctl}"
    height: 26px
    padding: 12px
  layer-row-active:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.ink}"
    rounded: "{rounded.ctl}"
  layer-row-indicator:
    backgroundColor: "{colors.brand}"
    rounded: "{rounded.full}"
    width: 2px
    height: 14px
  layer-subtree:
    backgroundColor: "{colors.selection-subtree}"
    rounded: "{rounded.ctl}"
  field:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.ink}"
    typography: "{typography.readout}"
    rounded: "{rounded.ctl}"
    padding: 4px
  paint-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-dim}"
    typography: "{typography.code}"
    rounded: "{rounded.swatch}"
    height: 30px
  align-button:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.swatch}"
    size: 25px
  dock:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.dock}"
    padding: 4px
  dock-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.dock-ctl}"
    size: 27px
  dock-button-active:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.brand-ink}"
  icon-button:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.ctl}"
    size: 23px
  rail-footer:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.micro}"
    height: "{spacing.rail-footer}"
  tag:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.tag}"
    rounded: "{rounded.sm}"
    padding: 4px
  toast:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.full}"
    padding: 8px
  popover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.pill}"
    padding: 4px
---

# FISH Workbench — Instrument Amber

## Overview

FISH is a professional vector design editor that ships as a single standalone HTML file. Its workbench must therefore read as **an instrument, not an app**: precise, quiet, and trustworthy at a glance, because it is also the first impression a designer gets of a tool they will open offline, by double-clicking one file.

The aesthetic is **Engineering Instrumentation on Obsidian**. The canvas is a black void; the workbench chrome is built from dark plates that **dock flush to the window edges** and are separated by 1px hairline rules rather than gaps. Every readout — coordinates, dimensions, zoom, hex values — is set in tabular monospace, aligned as if it were a measurement on a machined dial. Nothing is decorated; everything is legible.

The personality is **calm, exact, and unhurried**. The interface never competes with the artwork: chrome recedes into greys, and a single amber signal colour (`brand`, #E8A33D) is the only saturated warm note in the shell, reserved for the one thing that matters at any moment. The emotional target is *confidence through restraint*.

Target audience: professional designers and design engineers who value density, keyboard-first workflows, and local-first ownership of their files. The UI is dense but not cramped — a 4px spacing base and a repeating 25px row beat create rhythm without airiness.

## Colors

The palette is a **monochrome obsidian stack lit by a single amber signal**. Nearly every surface is a near-neutral dark grey; the amber accent is the sole warm, saturated element in the chrome and carries all interactive meaning.

- **Obsidian (`paper`, #101010):** the void behind everything — the app background and the canvas backdrop. Chosen over pure black so panel edges and grid lines remain perceptible.
- **Charcoal (`panel`, #181818):** the primary plate — side rails, their footers, and every popover's base. One step above the void, so panels read as objects resting on the background.
- **Slate (`surface`, #1E1E20):** a second elevation for nested chrome — the dock, paint rows, and menus.
- **Graphite (`raised`, #242428) / (`field`, #242424):** `raised` is a HOVER fill and the armed segment's fill — **not a menu fill**: a menu painted in `raised` made a hovered row disappear into its own menu (§The one menu). `field` is a control that sits *on* the panel surface rather than in it (the alignment grid's cells, the fields in a popover). Both are near-neutral.
- **`field-active` (#343434), the ARMED segment inside a `field` track:** neutral grey, never the amber wash. There is no neutral between `field` and `raised` (4 units apart — an invisible selection) and `surface` is darker than the track, so an amber segment would read as a tint rather than as a state; amber means "armed tool" everywhere else.
- **Pit (`inset`, #0A0A0A):** the deepest surface, used for inputs that must read as *carved into* the panel — below the panel plane, not above it.
- **Seam (`rule`, #242428) / Ridge (`rule-strong`, #333338):** the two hairline weights that draw every border and divider. Seam is the default 1px outline; Ridge is the stronger separation (tags, dock edge, menu edges). `paint-row-rule` / `paint-row-rule-open` are held separately from Ridge on purpose: both are appended to the same element, and two competing `border-*` utilities resolve by stylesheet order, not class order — folding them together hides the open state.
- **Paper White (`ink`, #ECF3F8):** primary text and the brightest readouts. Cold rather than neutral — the marine hue (245°) at 40% chroma, L\*-matched to the neutral grey it replaced, so every contrast ratio is unchanged. The hue is load-bearing: 245° is 45° off `canvas-select` (290°), which is what stops ink reading as a selection colour.
- **Ash (`ink-dim`, #9BA4AB):** secondary text — layer names, control labels, inactive tool icons.
- **Smoke (`ink-muted`, #666C70):** tertiary text — uppercase micro-labels, units, tag text. **It does not clear WCAG AA (3.3:1) and is for metadata only.**
- **Instrument Amber (`brand`, #E8A33D):** the single signal colour. It marks the armed tool, the commit/destructive action, and the hot readout, and measures 8.23:1 on `panel`. Its 12% wash (`brand-wash`) is the only tint fill used behind active chrome.
- **On-Brand (`brand-ink`, #2A1D08):** the deep brown used for glyphs and icons sitting on a solid amber fill, preserving contrast on the one bright surface. A **filled pictogram** — a silhouette that covers a third of the icon — takes `brand-ink-soft` (#503813, 5.1:1) instead: at full strength those blocks measured 7.6:1 and became the darkest mass in the menu, blacker than the label beside them. Hairlines stay on `brand-ink`; the soft value cannot hold a 0.8px edge on amber.
- **Row selection (`selection`, `selection-hover`, `selection-subtree`):** the layer list's selected row wears the **same amber wash as `brand-wash`** (`selection`), because a neutral wash on a #181818 panel is a ~4% step that reads as "slightly different grey" rather than as selected, and the layer list is the one place a user must never hunt for the selection. Rows *inside* the selected subtree stay at **a third of that wash** (`selection-subtree`, 4%) and lift only on hover, so the selected row remains the single brightest thing in the list.
- **The `-solid` trio (`selection-solid`, `selection-subtree-solid`, `selection-subtree-hover-solid`):** the **opaque, pre-composited** equivalents of the three washes above, worn by the row-action buttons (lock / eye). They overlay the truncated row name, so they must occlude it — and a translucent fill nested inside an already-tinted row **COMPOSITES** (12% over 12% ≈ 22.6%), which is what drew a darker box around the lock/eye on a selected row.
- **Canvas semantics — invariants, never re-themed:** `canvas-select` (#1B72FF Ocean Electric Blue) is the vector selection and anchor convention; `component` (#B794FF) marks components and instances. `snap-pink` and `measure-coral` (#FF5353 Reef Coral) paint snap guides and the measurement tool, and both only appear while a modifier or interaction is held, so neither shares the screen with `brand`.

> **`canvas-select` vs `selection` — two different things, and the names must not be swapped.** `canvas-select` is the *canvas* selection: the blue marquee, handles, and pen/shape previews drawn **over the artwork**, carrying editor semantics. `selection` is the *layer list's* row state: an amber wash inside the panel chrome. A token named `selection` that returns blue is a bug waiting to happen — always write `canvas-select` when you mean blue.

`component` is deliberately #B794FF rather than the more saturated #9747FF, which measures **3.94:1** against `panel` and therefore fails WCAG AA. The hue is unchanged, so "violet means component" still reads. `ink` measures 15.9:1 and `ink-dim` 7.0:1 on `panel`.

## Typography

**Two family stacks, but only one is inherited**: monospace is the default voice and `font-sans` is an explicit, countable opt-in.

- **Everything inherits monospace; anything that wants the humanist stack must say `font-sans`, and there must be a reason to review.** Tailwind 3's `fontSize` tuple **cannot carry a `fontFamily`**, so every family written beside a step in this file's frontmatter compiles to nothing — a `font-sans` on the shell root decides the voice for every component below it, and monospace survives only where someone hand-wrote `font-mono`. `html` in `src/style.css` is the single source of the shell's voice.
- Both are **system stacks only**. A webfont would add a file the shell cannot inline cheaply, so nothing here may name a family the build does not ship. Artwork is unaffected: canvas text carries its own `fontFamily` per element.
- **Sans (system UI stack):** reserved for human-facing chrome — the document name, the inspector's subject line, prose, and menu items. It signals "content and identity."
- **Monospace (system mono stack):** carries every piece of *data* — layer names, coordinates, dimensions, hex values, units, tab labels, status cells. Every numeric value uses `tabular-nums` with slightly negative tracking so columns of digits align into a clean vertical register.
- **Micro-labels:** section headers are `micro` (9px mono, weight 600, uppercase, 0.18em tracking) in `ink-muted`. They are structural, not decorative — each is followed by a leader rule that fades to transparent. Uppercase is a separate `uppercase` utility rather than part of the token: Tailwind 3 silently drops `textTransform` inside a `fontSize` tuple. The rule to keep: a micro label is **9px + wide tracking + UPPERCASE**, and all three must be visible in the markup to be reviewable.
- **Tracking is not decoration.** It is what keeps a 9px uppercase header legible and what stops a 10.5px mono value from looking loose beside a 12px sans label. Sizes alone produced the panel's earlier flatness.

**Chrome drawn INSIDE the SVG speaks mono, document text does not.** An SVG `<text>` cannot inherit the shell's voice the way a component does, so each site states its own family. The six chrome labels (frame title, instance title, component-set title, measurement badge, size badge, spacing read-out) use `CANVAS_CHROME_TEXT` in `src/ui/canvas/canvas-text.ts` — the shell's own mono stack, so an editor badge cannot re-space itself depending on whether the machine has a webfont installed. **Document content stores the family the author named and defaults to `system-ui`** — `DEFAULT_FONT_FAMILY` in `src/core/font-stack.ts`. The fallback is not part of the file: `resolveStack` appends `system-ui, sans-serif` at paint and measure time, because a stack that carried its own generic made a missing face undetectable (see `scratch/fonts.md`). The split is visible and correct — a frame's title matches the layer row it labels, while the copy inside the frame is the designer's font.

Titles are **400**. A title names a layer, and at 11px anything heavier stops describing it and starts competing with the thing it labels; 400 is also the only weight this system calls real on every face, which matters now that the stack is one we can guarantee.

**Title-bar readouts are `row` (10.5px), not `ui`.** The autosave status word and the zoom percentage sit in the 48px title bar next to a 13px document name; at 12px they read as headings rather than as readouts.

### Font weights: 400, 500 (sans), 600 (sans), 700 (mono marks)

The weights are chosen based on **platform availability and voice**:

| Weight | SF Pro (Apple) | Segoe UI (Windows) | Roboto (Android/Linux) | Helvetica Neue | Arial | SF Mono | Menlo | Consolas | Liberation Mono |
|---|---|---|---|---|---|---|---|---|---|
| 400 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 500 | ✓ | ✓ (Variable) | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| 600 | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| 700 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

- **400 is the only weight that is real everywhere.** It is the default; do not set it explicitly.
- **500 (`font-medium`) is for SANS action controls.** Standard buttons (`Button.tsx`), menus, and interactive badges opt into `font-sans font-medium` to achieve crisp, balanced emphasis on amber and interactive surfaces without the visual heaviness of 600. Mono faces lack 500, so `font-medium` is strictly paired with `font-sans`.
- **600 (`font-semibold`) is for SANS headings.** Titles and prominent labels (`text-displaySm`) use 600 where stronger structure is needed.
- **700 (`font-bold`) is reserved for monospace glyph marks** — the ❖ / ◇ / ▦ component and instance badges, which need real weight at 8–12px on a mono face. It is also the only emphasis weight that is real on every platform, so reach for it when a mono label must genuinely be heavier and colour alone will not do.
- **650 does not exist** — it renders as a true 650 only on Apple's variable system font and rounds to 600 or 700 everywhere else. It is not in this scale.
- **Never let weight carry meaning alone.** Because weights degrade to synthesis on some platforms, the emphasis on a micro-label is carried by **size + tracking + uppercase + colour**, with weight as a supporting cue rather than the load-bearing one.

Weight discipline is strict: **400, 500 (sans controls), 600 (sans headings), 700 (mono marks)**.

### The label tiers

Four tiers. A label that names a **group or a control on its row** used to be written in two colours at once — `Text Styles` in `ink-dim`, `Clip content` in `ink-muted` — so two labels of identical rank read as two ranks. It is now ONE class (`SUB_LABEL_CLASS` in `src/ui/label-tier.ts`) used by every site:

| Tier | What it names | Type | Colour |
|---|---|---|---|
| **Sub-label** | a group or a row's control — `Text Styles`, `Clip content`, `Angle`, `Stop 1/2`, `Instance of:` | `meta` (9.5px mono), 400 | `ink-dim` |
| **Section header** | a section — `FILLS`, `EFFECTS`, `LOCAL STYLES` | `micro` uppercase + leader rule, and the fold's chevron | `ink-muted` |
| **Field key** | the key inside a well — `X`, `W`, `%`, `TL` | `meta`, in `ScrubInput` | `ink-muted` |
| **Prose** | empty states, descriptions, notices | `row` + `leading-snug` | `ink-muted` |

Two rules keep the tiers apart:

- **Only the section header is uppercase.** Two uppercase tiers three pixels apart read as one tier that failed to line up. A sub-label is separated by SIZE (9.5 vs 9), by case (sentence vs caps), by tracking (none vs 0.18em) and by colour (`ink-dim` 7.0:1 vs `ink-muted` 3.3:1) — four signals, so no single one has to carry the distinction.
- **`meta`, not `ui`.** The mono default made this urgent: a 12px monospace label is wider than the value it names, and the reference layout's keys are 9–9.5px. `ink-muted` at 9.5px is too faint, which is why the sub-label is `ink-dim` — a label is metadata, but it still has to be readable at that size.

Only the chrome heads keep 600 — the **three `font-sans`** sites, the only humanist text in the shell: the title bar's document name, the inspector's selected-name subject line, and the picker/popover/panel titles. All three use `text-displaySm` (13px/600), so the two "what is selected / what file is open" readouts share one voice.

**Sizes come from this scale and nothing else.** Tailwind's stock steps (`text-xs`, `text-sm`, `text-base`, …) are not sizes in this system: they carry no tracking and their own line-height, so the same 12px is two different objects depending on which one was written. Mono means data: a number is `readout` (tabular), a hex is `code`, a unit is `unit`, a field key is `meta`.

## Layout

The workbench is a **docked three-region shell**, not a set of floating cards. Regions share 1px `rule` borders and butt directly against each other and the window edge — there is no gutter and no gap between them.

```
┌──── titlebar (document name, updates | zoom, present) ────┐
│  left rail   │              canvas (fluid)              │   right rail 288px     │
│  (resizable) │                                          │   (inspector)          │
│              │                                          │                        │
└──────────────┴──────────────────────────────────────────┴────────────────────────┘
```

- **Left rail (resizable, drag handle on its right edge):** panel tabs (`h-10`, 40px) → a **PAGES** band → the page list → a **LAYERS** band → the layer tree. The list container insets its rows by **8px**, so a row is an inset chip, not a full-bleed band — that classification is what decides its radius and its selection mark. Rows then indent 12px per depth level from an 8px base padding, so glyph and label columns stay aligned — the base is 8, not 12, because it stacks on the container's own 8px inset and a top-level row at 20px read as indented for no reason. The rail carries `border-r`; it is not rounded.
- **Section bands:** each band is a 9px mono uppercase label at the rail's 12px gutter, followed by a leader rule, with an optional trailing control (Pages carries `+`). Every section label in either rail — these bands and the inspector's group labels — is **collapsible**, and all of them share one affordance: the chevron hangs in the 12px gutter to the left of the label, hidden until the pointer is over the label — a permanent chevron competes with a strip whose whole job is to be a heading. A *collapsed* band always shows its chevron, because a collapsed section with no visible affordance is a dead end.
- **Canvas (fluid):** the document stage, with a faint grid and corner ticks. It is the only region that is not chrome.
- **Right rail (288px):** the inspector. Fixed width, `border-l`, a fixed header (component name + type) over a property stack — Align, Position, **LAYOUT** (the size fields — W/H, aspect lock, bounds, shape geometry — followed by the stack controls, closed by the clip switch; "resize to fit" hangs in the header's trailing slot), **APPEARANCE** (corner controls, then blend/opacity; the independent-corners switch hangs in the trailing slot), then Fill, Stroke, Effects — each introduced by a micro-label and a fading leader rule. Every one of those labels is a **group heading**, and every heading **collapses** with the same affordance as the rail's bands: a chevron in the 12px gutter to the left of the label, drawn on hover and always drawn once the group is folded. Folding hides the group's controls and nothing else — the heading, its leader rule and its trailing control stay, so a folded group is still readable and still expandable. The fold is **session state, not a document property**: it is remembered per heading (so it survives picking another layer, and a group folded in one selection is folded in the next), and it is deliberately not persisted, because a remembered "collapsed" is a panel that opens looking empty with nothing on screen to explain it.
- **Zoom in the title bar:** the cluster takes the right side, with Present past a `rule` seam in the outer corner and the readout as its one "hot" cell in `brand`. Updates sits to the left, immediately after the document name. Both are inside the measured top panel, so `unobstructedArea` sees them. Neither rail has a footer: the panel content runs to the bottom edge, and the current layer's parent is reachable from the **LAYERS** band's trailing actions.
- **Spacing base:** 4px (Tailwind's default scale — the theme adds no spacing tokens). The repeating row beat is **25px**, produced by the field/row padding rather than declared as a token.
- **Canvas grid:** snapping defaults to an **8px** grid, independent of the visual grid overlay.

## Elevation & Depth

Depth is expressed through **tonal stacking plus one signature hairline**, never through soft ambient glow.

- Surfaces step: `inset` (#0A0A0A) → `paper` (#101010) → `panel` (#181818) → `surface` (#1E1E20) → `raised` (#242428) → `field` (#242424). Lighter = closer to the viewer.
- **Docked chrome carries no shadow.** The rails are separated from the canvas by their 1px `rule` border alone. A shadow on a docked plate would imply it floats, which it does not.
- **Floating layers get exactly three shadow tiers**, declared once in the theme:
  - `panel` — `0 1px 2px rgba(0,0,0,.4), 0 10px 28px rgba(0,0,0,.34)`: the workhorse for a raised panel.
  - `popover` — `0 1px 2px rgba(0,0,0,.45), 0 12px 34px rgba(0,0,0,.46)`: menus, the dock, the autosave popover.
  - `modal` — `0 2px 6px rgba(0,0,0,.5), 0 24px 60px rgba(0,0,0,.55)`: dialogs.
  Stock `shadow-sm/md/lg/xl/2xl` are **not** part of this system.
- **Recessed controls invert the logic:** fields and value wells use an **inset** shadow (`inset 0 1px 2px rgba(0,0,0,.45)`) to sit *below* the panel plane. Without it, a recessed background alone still looks like a flat swatch.
- **Never a coloured or glowing shadow.** Elevation is tonal plus neutral shadow only. A tinted glow is both off-system and, when it borrows `canvas-select`, a semantic collision — the canvas's blue means "selected", not "glowing".
- **One more shadow that is not a tier: the 1px dark ring** (`DARK_RING_CLASS` in `src/ui/ring-style.ts` — `0 0 0 1px rgba(0,0,0,.45)`). No blur, no offset: it exists so a 2px amber indicator bar or a 12px dot does not dissolve into what it overlaps. It has its own module rather than a fourth tier because it is legibility, not elevation, and an arbitrary `shadow-[…]` is exactly what the guard test bans.

## Canvas palette

The canvas paints with SVG presentation attributes, where a Tailwind token cannot reach — so its colours live in `src/ui/canvas/canvas-colors.ts`, one named value each, and `ui-conventions.test.ts` allowlists that file by name so the SVG-hex check can cover the whole canvas instead of skipping it.

| Name | Value | Means |
|---|---|---|
| `CANVAS_SELECT` | `#1B72FF` | selection, drag, pen/vertex handles, the shape being drawn |
| `CANVAS_COMPONENT` | `#B794FF` | a component or variant set (AA on canvas; matches the panel mark) |
| `CANVAS_ON_SELECT` | `#FFFFFF` | ink sitting **on** one of the two above |
| `CANVAS_SMART_SELECT` | `#FF5353` | the thing the pointer is over — a different statement from "chosen" |
| `CANVAS_MEASURE` | `#FF5353` | an instance resized away from its master, or distance measurement |
| `CANVAS_PREVIEW` | `#5EA2FF` | the pen's rubber band: a future stroke, deliberately lighter than select |
| `CANVAS_GUIDE` | `#888888` | dashed gradient guides, an unselected frame's title |
| `CANVAS_MASK_KEEP` / `_CUT` | `#FFFFFF` / `#000000` | the luminance mask vocabulary, not ink |
| `CANVAS_BADGE_*` | `#1E1E1E` / `#333333` / `#E0E0E0` | the size badge's surface / ridge / ink, restated because it is drawn inside the SVG |
| `CANVAS_MARGIN` | `#1B72FF` | the **margin** band only, and the grid's **cell preview** — the two marks that describe the inside of a container while that container is on the canvas. Named for what they mean so the value can move |

Alpha is the one thing a token cannot express on an SVG attribute, so it is `withAlpha(colour, a)` from the same module rather than a named wash per call site. `ui-conventions.test.ts` matches `rgb`/`rgba`/`hsl`/`hsla` as well as hex, in both the plain and the `fill={… ? A : "#888"}` form.

**Spacing bands (padding / gap / margin).** Dragging a gap on the canvas, or any of the three in the inspector, draws the same thing: a tinted band over the space being changed with its live pixel size in a pill. One component (`SpacingBandView`) draws all three, so the two entry points cannot drift.

- **Padding and gap wear coral**, the geometry accent — the space *inside* the container's own arrangement, which is what the gap pill already meant.
- **Margin wears `CANVAS_MARGIN`** (`#1B72FF`), **outlined and dashed**, with a solid pill in white ink. Margin is the space a child claims *around* itself: structure, not a measurement, and the canvas's two saturated meanings are blue = chosen and coral = geometry. The sign is kept — a negative margin draws the overlap it causes, inside the child's own box.
- Two rules the bands inherit: a value of **0 still draws** (a band floored to a hairline, straddling the boundary it sits on) — a scrub whose readout vanishes at the value most people set it to is a scrub with no feedback — and only the sides **under the pointer** are drawn, because padding's four bands lit at once is four pieces of feedback about one number.

  **The dashed outline is load-bearing, because hue alone cannot do this job.** Two candidates were measured against the other canvas semantics with the colour story's own three tests:

  | | contrast | min ΔE00 | min hue | nearest |
  |---|---|---|---|---|
  | `#7A6BB5` Jellyfish | 3.89:1 | 16.1 | **4.1°** | `CANVAS_COMPONENT` |
  | `#1B72FF` selection blue | **4.14:1** | 14.9 | **13.3°** | `CANVAS_PREVIEW` |

  Neither clears that page's ≥30° same-family gate, so treatment is the primary channel and the colour is the third — the two are told apart by solid-vs-dashed and by the pill, and hue only reinforces it. The blue was chosen for the contrast and the 3× larger hue separation; its cost is that it is also the colour that means "chosen", and during a scrub the selection chrome stands down, so the band is briefly the only blue on the canvas. White on the pill is 4.29:1, where the neutral badge's `#E0E0E0` ink measured 3.46:1 and failed AA.

## Scrollbars

- **6px, and the webkit pseudo-elements are the ones that count.** `scrollbar-width` is a standard property and Chromium implements it — setting it makes Chromium draw its OWN scrollbar and ignore `::-webkit-scrollbar*` entirely, hover included, and `scrollbar-color` has no hover state to tune. So `scrollbar-width: thin` is scoped to Firefox with `@supports not selector(::-webkit-scrollbar)`, and Chromium gets the pseudo-elements: **6px** (11px reserved a gutter wider than the 12px padding it sat in, which is why panel padding never looked equal on both sides) and a hover we control.
- **16% at rest, 26% on hover.** The thumb sits on `panel`, so 16% reads as #3A3A3A — present when looked for, invisible otherwise. The hover must be a *step*, not a different colour: an earlier 32% was brighter than most chrome hairlines and pulled the eye onto a 6px strip.

## The one menu

A menu is a popover with rows in it, so it is defined once in `src/ui/menu-style.ts` and every menu wears it: the right-click `ContextMenu`, the dock's three tool menus, the inspector's effect-kind and boolean menus, the component picker.

- **Width** `min-w-[216px]` — the dock menus were a hard `w-36` (144px), which does not hold "Reset instance" in 12px monospace.
- **Surface** `bg-surface` + `border-rule-strong` + `rounded-pill` + `shadow-popover`. `raised` was wrong twice over as a menu fill: it is also the row HOVER, so a hovered row disappeared into its own menu.
- **Separator** `bg-rule`. The dock's separators were `bg-raised` **on** a `bg-raised` menu — a 1px line of the colour it was drawn on, i.e. invisible.
- **Sizes:** a row is 26px; a popover's committing action is 25px (`Button size="field"`), because a 20px primary button sat 5px below everything else in its own panel and read as a label rather than a button.
- **Rows** 26px, `text-ui`, **no transition**. A menu opens on the press and the pointer is already over the row it lands on, so a fade means the first thing the user sees is the row mid-transition; instant is also what Figma and macOS do here.
- **Hover is brand amber** (`hover:bg-brand hover:text-ink`). A menu row *is* a command, and lighting it in the command colour is the one place that reading is true rather than borrowed. The row that is currently armed wears `text-brand` at rest and flips to `ink` on hover — brand text on brand fill is invisible.
- **Shortcut hints are set in the label's own type step**, dimmer and right-aligned with a guaranteed gap. At a smaller step they sat on a different baseline and read as crowding rather than as a second column.

## Motion

Two curves and three durations, declared once in the theme. There is no animation library: the shell has 36.5KB of headroom and a spring bundle would spend it.

- **`duration.micro` (120ms)** — state that must feel instantaneous: hover, colour, tab switches.
- **`duration.base` (180ms)** — general transitions.
- **`duration.slide` (260ms)** — panels whose *position* carries meaning: the rails sliding in and out, the dock hiding.
- **`ease.snap` (`cubic-bezier(.2, 0, 0, 1)`)** — for `micro`; decisive, no overshoot.
- **`ease.slide` (`cubic-bezier(.32, .72, 0, 1)`)** — for `slide`; a fast start that settles.
- **`pop-in`** — popovers and menus scale from `.97` with a fade, growing out of the edge that triggered them (transform-origin set inline per placement).
- **`fade-in`** — overlays.
- **`pulse-soft`** — the autosave dot, 1.4s, slow enough to read as "working" rather than "blinking".

Durations are short on purpose: a design tool is held all day.

## Shapes

Radius is not a size scale — it is an **elevation scale**. The further a surface floats above the plane, the rounder it gets. The rule is stated by **classification**, never applied as a mood, which is what keeps the dock generous and the layer rows tight without either looking like an exception:

| Height above the plane | Radius | What lives there |
|---|---|---|
| **Flush** — the thing *is* the surface | `none` (0) | the side rails and their footers |
| **Inset** — carved into, or laid on, a surface that continues past it | `sm` 2 / `swatch` 3 / `ctl` 4 | tags, swatches, fields, paint rows, align cells, tool icons, tabs, **layer rows and page rows** |
| **Low float** | `pill` 6 | context menus, popovers |
| **High float** | `panel` 9 / `dock-ctl` 10 / `dock` 14 | panels, cards, the dock |
| **Transient** | `full` | toasts, the present-mode bar, status dots, indicator end caps |

Two consequences that are easy to get wrong:

- **A corner radius and a leading-edge mark compete for the same 4×4px.** A 4px arc cuts a full-height 2px bar into a diagonal wedge — on a 26px row that destroys ~28% of the bar, and a mark with an angled termination reads as a rendering fault, never as intent. So a surface carrying a leading indicator must either be **square on that edge**, or the indicator must be **inset clear of the corner**. This system takes the second route, because its list rows are inset chips rather than full-bleed bands.
- **Nested radii must be concentric**: an inner element's radius ≈ its parent's radius − the padding between them. A pill (effective radius = half its height) may only contain pill-shaped controls; a 4px button inside a 16px pill reads as two different systems bolted together.

Borders are always **1px hairlines** in `rule` or `rule-strong`. The only thicker stroke is the semantic 1.5px canvas selection box.

> **Pills are allowed — for transient surfaces and end caps.** The docked workbench chrome contains no pills, but toasts, the present-mode bar, and the rounded end caps of a 2px indicator bar legitimately use `full`. The distinction is *transient overlay vs. docked chrome*, not "modern vs. square".

## Components

Components are the machined parts of the workbench. Each consumes only semantic tokens — no ad-hoc hex values, no stock palette utilities, no arbitrary `rounded-[Npx]` or `shadow-*` outside this system.

- **Panel:** the base plate. `panel` fill, `rule` border, **no radius** when docked.
- **Titlebar / panel tabs:** a 40px header holding `tab` (11px mono) labels. The active tab is `ink` with a 2px `brand` bottom border; inactive tabs are `ink-muted` with a transparent border. Tabs are `rounded-none` so they sit flush on the header rule.
- **Layer row:** a 26px `row` (10.5px mono) chip, inset 8px from the rail by the list container, `ctl` (4px) radius. Hover lifts to `selection-subtree-hover-solid`; the active row uses `selection` plus a **2px × 14px `brand` indicator bar**, inset 4px from the row's left edge so it never meets the corner arc. The bar, not the wash, is what makes selection unmistakable at a glance. A row inside the selected subtree stays at `selection-subtree` and only lifts on hover, so the selected row remains the strongest mark in the list. **The label elides** — a row is never wider than the rail. A name that sizes the list instead means the row grows past the rail and its own marks (theme mode, mask, the lock/eye) are what fall off the end; the rail is resizable, and the label's full text is on hover.
- **Page row:** the same 26px chip and the same `selection` + indicator mark as a layer row — a page is a row in the same list, not a different species. It carries **no border**: an outline around the active page made the selection read as two marks (wash + stroke) when every other selection in the rail is one (wash + bar).
- **Row actions (lock / eye):** absolutely positioned over the row's right end, so they must occlude the truncated name — hence a background at all, and it is the **opaque equivalent** of whatever is already behind them (`selection-solid`, `selection-subtree-solid`, `selection-subtree-hover-solid`), never a second tint. **Both the fill and the chip are hover-only:** an idle row paints nothing there, because a fill without the icons is a bare rectangle over the label's tail (which is exactly what a permanently reserved 34px slot looked like). Only a mark that is *true* while the row is at rest keeps a slot in the flow — a missing font, an external source, and a lock or eye that is currently **off**; those four must be readable without pointing at them.
- **Section header:** a **fixed 31px** row — `pt` 15px, `pb` 7px, `text-micro` label, a fading leader rule, and an optional trailing control. A group boundary is asymmetric on purpose: the label belongs to what follows it, so it sits closer to its group than to the group above. The trailing control is wrapped so it **cannot change the row's height**. The label's **caps** — not its line box — are what the row centres: UPPERCASE draws no descender, so at 9px/1 the 2.3px under the baseline are inkless and the caps' optical centre sits 1px above the box centre. The label carries that 1px (`MICRO_LABEL_AXIS_CLASS`) rather than the chevron, the rule and any trailing control each carrying one of their own, so a control added to a heading is aligned without being told.
- **Slider:** the inspector's slider is a **6px** line — a 6px `brand` fill growing out of the neutral, and an **11px square `ink` handle** — inside an 8px hit area centred on the line. No hairline: a 1px ring would eat a sixth of a 6px track. The pointer target is the hit area, never the mark.
- **Colour rail:** the colour panel's hue and alpha bars are their **own** width, **6px**, with the **same 11px square handle** — a rail's gradient *is* its value and needs the width to read, but the handle is not a second design: one gesture, one grip, wherever it happens. Same 12px hit area, same "no hairline" rule. A slider and a colour rail are the same gesture, so they are the same thickness.
- **Field (readout):** an `inset` well — the deeper fill alone, **no inset shadow**: the shadow made the same field read as a different, deeper object beside a `Select` or the link field, which carry none. The key (`X`, `W`, `R`, `%`, `°`) is `meta` (9.5px) mono in `ink-muted`; the value is `readout` in `ink`, right-aligned and tabular so digits do not shift width while scrubbing; the unit suffix is `unit` in `ink-muted`. Values show two decimals. A field inside a 30px paint row is **20px**, not 25px, so the card's own padding stays visible.
- **Grid track field:** the auto-layout inspector's track box. The unit is a `meta` **caret button, not a bare `px` suffix** — a bare suffix reads as a label and is not one, and it rearranges the row; a menu is the only surface that can carry the sentence saying what the choice does. Its options are the size menu's own two-line option row (`MENU_OPTION_CLASS`, name + `MENU_OPTION_NOTE_CLASS`) with the current unit checked, so a unit reads as that kind of choice rather than as a suffix. The number in the well is a **weight, not a size**, so the pixels it resolves to right now are said in the row's `title`.
- **Paint row:** a `surface` row with a 1px `paint-row-rule` ring, holding a swatch (itself ringed by a 16% white inset), a `code` (10px mono) hex, and a right-aligned `meta` alpha percentage. A "none" stroke is an empty ringed swatch with the literal text `NONE`.
- **Align cluster:** a 6-column grid of 25px `field` buttons with centred 12px stroke icons at 55% opacity.
- **Tidy-up badge:** the canvas's ragged-row affordance — a coral rounded square carrying three bars in the axis being evened out, upright for a row and horizontal for a column. **20px**, two and a half corner handles (8px), which is the size Figma's distribute mark reads at (`TIDY_BADGE_D`); hung off the selection's bottom-right corner, just clear of the corner handle and bottom-aligned with it. It carries **no caption** (`aria-label` + an SVG `<title>` only) and casts **no shadow**, and it does **not** invert on hover: the whole thing means *these three gaps are not equal*, and a badge that swaps to white ink, or floats, stops looking like the thing it offers. When it appears, and what one press equalises, is `src/ui/canvas/SmartSelectionOverlay.tsx` (`TIDY_BADGE_D` and the row-chrome conditions).
- **Dock:** a centred floating `surface` bar, `rounded.dock`, carrying `dock-ctl` tool buttons separated by 1px `rule-strong` dividers. Exactly one button is armed at a time, filled solid `brand` with a `brand-ink` glyph.
- **Button:** one component, `src/ui/Button.tsx`. Six variants — `ghost` (the default: no chrome at rest, `ink-dim` → `ink`, `raised` wash on hover), `primary` (the one committing action in a surface: solid `brand` fill, `brand-ink` text, `font-medium`; never a tool, a row action, or a resting state), `danger` (a ghost whose hover goes `measure-coral` — never a resting colour), `menu` (a full-width dropdown row), `bar` (the wide action that closes a section, in a field's box) and `boxed` (a small button wearing a `rule` hairline). Sizes are **boxes, not paddings**: `icon` is a 20px square — the slot a section header reserves for its trailing control — `iconLg` is 26px for the inspector's own header, `text` is 20px tall and as wide as its content. Naming the box is what stops the same 13px glyph being 19, 21 or 22px tall depending on which file it was written in.
- **Icon button:** `ghost` + `icon` — 20px, `ctl` radius, `ink-dim` glyph; hover raises to a `raised` wash and `ink`.
- **Updates panel:** the workbench's one app-level surface — a title-bar `icon` button (left cluster, beside the document name) wearing a 6px `brand` end-cap dot when a newer shell exists, opening a `POPOVER_SURFACE_CLASS` panel that reads `FISH` / `v0.0.1` in the `displaySm` + `row` pairing the document hub uses. It is NOT in the document hub, and that is the whole reason it exists: every row in that popover acts on the file in this tab, while an update replaces the *shell* every file carries and leaves the document alone. Its committing action is `primary` + `field` + `block`, the popover's own committing-action spec; its `CheckRow` wears the sub-label tier because a toggle on a row is a row's control. A build with no release endpoint says so in the status line — a panel that goes quiet because it has nothing to report reads as "nothing to do here", which is a lie.
- **Zoom:** the title bar's right side holds the cluster, its readout the only "hot" cell, in `brand`; Present keeps the outer corner. Updates sits beside the document name on the left. The inspector has no footer; the layer tree runs to the bottom edge of the left rail.
- **Tag:** a 2px-radius `rule-strong`-outlined micro-badge for dimensions (`250×104`) and type kinds (`FRAME`, `COMP`, `INST`).
- **Missing-font mark:** the layer row's warning — an 11px `measure-coral` `AlertTriangle` between the name and the trailing badge cluster, always drawn rather than hover-gated like the eye and the lock, because a warning you have to find arrives too late. `measure-coral` is already the shell's "something is wrong" note (`AppNotices`, `AutosaveBadge`), so `brand` keeps meaning *armed*; amber would also sit on the amber wash of a selected row and read as the selection. It is a BUTTON that opens the missing-fonts dialog and stops the press there — a mark that only explains leaves the author to find the fix, and selecting the layer is not what the press asked for. Its `title` names the family and says what happened to the box, and it carries `data-layer-missing-font` for the spec that grades it. The **canvas draws no badge**: the substituted face is already visible as itself, and a tag per layer would annotate the artwork the tool exists to show. The canvas node carries `data-font-missing="<family>"` instead — the assertion surface, not a second design. What decides this, and what freezes the box, is `src/core/fonts/font-status.ts`; see `scratch/fonts.md`.
- **Missing-fonts dialog:** the one surface that explains a refused edit and fixes it. A centered `max-w-md` dialog — `shadow-modal`, `popover` chrome, `displaySm` sans title — NOT a toast and NOT a docked panel: everything on it is a choice between replacements, and a self-dismissing pill cannot carry a choice. It opens from the gate in `useInlineEditing` (double-click on a text whose family is missing) and from the layer row's mark; opened by the gate it also carries a `bg-inset` strip naming BOTH the layer and the family, because "this text can't be edited" without which text is a dialog that interrupts and explains nothing. Rows list every family the document names that this machine cannot paint, with the counts that make the choice proportionate (`1 text layer · 2 runs · 1 text style`). The scope toggle states its consequence instead of being implied by which of two similar buttons was pressed: `Selection (n)` is the layers the author picked, `Document (n)` is the file — and only the document scope can rewrite a shared text style, which is why replacing on the selection detaches a bound layer. Its state is module-level (`src/ui/missing-fonts.ts`) rather than a prop, because the opener is a gesture three levels below the shell.
- **Toast / overlay:** a transient floating pill (`rounded.full`, `panel` fill) with a `ui` body. Overlays are the only place pills appear.
- **Canvas overlays (selection, pen, shape, path, snap, measure, spacing bands):** these are **not chrome**. They paint over the artwork and must consume the canvas semantic colours (`canvas-select`, `component`, `snap-pink`, `measure-coral`) — never `brand`, and never a hard-coded hex. They also draw at the artwork's scale, so their stroke widths are computed, not tokenised.

## Do's and Don'ts

- **Do** reserve `brand` (amber) for the armed tool, the commit action, the selected layer row, and the single hot readout.
- **Don't** use amber for body copy, large fills, or more than one element competing for attention in the same view.
- **Do** set every number, coordinate, dimension, hex, and unit in tabular monospace so digits align in vertical columns.
- **Don't** use font-weight 650, or 500 on monospace. The set is **400 / 500 (sans controls) / 600 (sans headings) / 700 (mono marks)**.
- **Don't** rely on weight alone for emphasis — carry it with size, tracking, uppercase, and colour, because 600/700 degrade to synthesis on some platforms.
- **Do** keep the 1px hairline on every plate — it is the system's edge signature.
- **Don't** put a shadow on docked chrome. Only floating layers get `panel` / `popover` / `modal`.
- **Don't** add coloured or glowing shadows; elevation is tonal plus neutral shadow only.
- **Do** keep `canvas-select` (#1B72FF) and `component` (#B794FF) invariant and reserved for canvas semantics; never use them as decoration.
- **Don't** substitute the more saturated #9747FF for `component` — it fails WCAG AA (3.94:1) against `panel`.
- **Do** keep radii on the declared scale and pick them by **height above the plane**, not by element size; `rounded-[Npx]` is not allowed.
- **Do** keep nested radii concentric — an inner radius ≈ its parent's radius − the padding. A pill may only contain pill-shaped controls.
- **Don't** put a leading-edge bar on a rounded surface: the corner arc cuts it into a wedge. Either square that edge or inset the indicator clear of the corner.
- **Don't** nest a translucent selection fill inside another — the two composite and the inner one darkens. Use the `-solid` equivalent of whatever is already behind it.
- **Do** draw the component / instance marks as **SVG**, never as a text glyph. A glyph's ink sits wherever the *platform's* font metrics put it, so the same character lands at a different height on macOS, Windows and Linux and can never be centred against the 13px icon set it sits in.
- **Don't** put pills on docked chrome; `rounded.full` is for transient overlays, circular elements, and indicator end caps.
- **Do** maintain WCAG AA: `ink` (15.9:1) and `ink-dim` (7.0:1) pass on `panel`; `ink-muted` (3.3:1) is metadata-only.
- **Don't** hard-code a hex inside a component. Canvas overlays go through `canvas-colors.ts` (see §Canvas palette) — that is the one place a hex is allowed to live.
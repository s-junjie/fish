# FISH Workflow

The DSL itself is in `dsl.md`. This file is how to move: adopt the right posture, get a document open, edit it, source what it needs, and verify the result.

**If `./tools/fish` exits without running, read the reason before anything else.** A refusal that names two versions, or a document dialect this kit does not speak, means the kit and the file are not one FISH: re-install (`SKILL.md` § "Get the kit"). Never retry past it, and never translate the document by hand.

---

## 0. Working posture: intent, then draft, then depth

Two independent settings, not one mode: **what you know before you draw**, and **how far you take the result**.

Order matters more than either setting: **ask, then read, then draw.** The intake round is the task's first turn; the references describe how to build, and none of them can say who the document is for. Reading them first also guesses wrong about the format — a deck needs none of the poster guidance, a 24×24 icon needs none of the deck's slides — so the answer decides what was worth opening.

- **Intake — mandatory for a new design the request does not fully specify** (`intake.md` §1 is the test). One round of at most three questions with defaults, then `intent.md`, then the first element. Skipping it saves a turn and spends it later, on 400 elements the user has to review one at a time. It is not a phase for edits: an existing document already carries its brief, so a local change asks nothing.
- **Depth — draft by default, polish on demand.** Draft the skeleton with a minimal token table, labelled placeholders and `component` + `instance` for anything repeated; run the structure check only; state assumptions and refine on feedback. When the user asks for flagship work, a final picture, or a polish pass, gate on the short blueprint (§6.1) and finish with full verification (`--strict --geometry --audit` + `shot.sh`).
- **What both share:** every assumption that would otherwise stay invisible goes into `intent.md`, and the handover names it.

Do not make the user learn internal mode names; map their intent directly onto these steps (§6).

---

## 1. Inspect the project, not the kit

```bash
./tools/fish brief                       # no document yet: the intent record and the material already in the directory
./tools/fish brief existing.fish.html    # tokens, styles (with binding counts), components, assets, fonts
./tools/fish inspect <elementId> existing.fish.html   # ONE node: the box it got, its effective style, its parents, its overridable slots
./tools/fish compact existing.fish.html  # the document as compact JSON
```

`inspect` is the one to reach for before writing by id. It prints the box the layout
actually produced — with the `x/y` the file wrote beside it when the flow discarded
them — and, for an instance, the exact `targetId` / `property` pairs its overrides may
use (`--all` lists every slot, `--json` for a machine). An override that names a node
outside the master, or a property the node cannot carry, is skipped at paint time;
`check` reports it, `inspect` shows why.

Reuse what the document already carries. Ask only what neither the document nor the user's prompt can answer. `references/` is not part of this recon — nothing in the kit describes this project, so opening it is never a substitute for asking, and never a reason to ask later.

The one answer neither the document nor the directory can give you is what the user has elsewhere: a moodboard on their desktop, a brand kit in a wiki, the logo in last quarter's deck. That is the intake's material question — asked once, before any search (`intake.md` §5; §4 below).

Project categories guide the DSL choices:

- `ui`: app screens, dashboards, landing pages → frames, auto-layout, 8px rhythm, components.
- `graphic`: social cards, posters, covers → wrap the entire design in one top-level frame (the poster artboard, with explicit dimensions and `clipsContent: true`; its `name` displays as the canvas artboard label above it, not in exports), use free placement inside it (auto-layout only where content repeats), declare `fonts[].src` for export, and say `overlap: "allowed"` on a frame whose type is composed to cross something.
- `brand`: logos and marks → pure vector paths.
- `dataviz`: charts, gauges, rings → sibling `ellipse` arcs.
- `icon`: 24×24 paths.
- `deck`: top-level frames as slides, with `slide.transition`.

---

## 2. Create with Compact JSON

Author DSL JSON with the shorthands in `dsl.md`, then assemble it into the shell (`--out` defaults the template to `templates/blank.fish.html`; pass an explicit `<template.fish.html>` second if reusing a custom shell):

```bash
./tools/fish compose design.json --out design.fish.html --compact
```

Or pipe it:

```bash
./tools/fish compose - --out design.fish.html --compact <<'EOF'
{ "version": "0.1", "canvas": { "width": 1440, "height": 900 }, "elements": [] }
EOF
```

`compose` normalizes before it writes, so the block in the file is the REPAIRED document, not the one you passed. It therefore prints every repair and **exits 1** when any of them changed what you wrote — fix the JSON and compose again, because `check` on the assembled file has nothing left to report (the broken value is already gone). A clean compose is the only one that exits 0. `apply` holds the same rule for the write: a CSS-spelled op whose value cannot be stored fails by name, and a run that dropped anything on the way out exits 1 even when the op itself ran.

> **Migrating an existing HTML page:** Only when the user provides an existing `.html` file to convert, run `./tools/fish import page.html --out design.fish.html --viewport 1440` once as a seed, then iterate with `apply` — never re-run `import` over an edited `.fish.html` or it will discard edits (see `dsl.md` § "HTML In").

---

## 3. Edit with macro-ops

The artifact itself carries no op runtime; the agent kit's CLI runs every op below against the `#design-doc` block and writes it back. Both `ops.json` files and inline JSON (`[...]` or `{"ops":[...]}`) are accepted:

```bash
./tools/fish apply ops.json design.fish.html --compact
```

| Op | Shape & Semantics |
| :-- | :-- |
| `patch` | `{"op":"patch","targetId":"<id>","props":{...}}` — deep-merge fields (`null` unsets a key; accepts CSS spellings, `$token`, and instance-derived ids from `inspect`). |
| `replace` | `{"op":"replace","targetId":"<id>","element":{...}}` — replace a subtree, preserving `targetId`. |
| `insert` | `{"op":"insert","element":{...},"parentId":"<id?>","position":{"x":0,"y":0}\|"side-by-side"}` — add under `parentId` or canvas (`position` optional; `{x,y}` uses canvas world coords). |
| `remove` | `{"op":"remove","targetIds":["<id>",...]}` (or `"targetId":"<id>"`) — delete elements by id. |
| `intent` | `{"op":"intent","intent":"wrap-in-stack"\|"wrap-in-grid","targetIds":["<id>",...],"params":{"direction":"row"\|"column","columns":2,"gap":24,"padding":0,"name":"...","id":"..."}}` — wrap siblings sharing one parent. |
| `boolean` | `{"op":"boolean","intent":"union"\|"subtract"\|"intersect"\|"exclude","targetIds":["<id1>","<id2>",...]}` — combine ≥2 top-level shape outlines (`operation` aliases `intent`). |
| `make-component` | `{"op":"make-component","targetId":"<id>","name":"<optional>"}` — promote a frame (or wrap and promote a leaf, minting a new id) to a master. |
| `instantiate` | `{"op":"instantiate","componentId":"<masterId>","parentId":"<id?>","position":{"x":0,"y":0}}` — place an instance of a master. |
| `reset-instance` | `{"op":"reset-instance","targetId":"<instanceId>"}` — clear instance overrides and local instance paint/mode/scale deltas. |
| `detach-instance` | `{"op":"detach-instance","targetId":"<instanceId>"}` — expand an instance into a plain frame. |
| `make-variant` | `{"op":"make-variant","targetId":"<componentId>","property":"State","value":"Hover"}` — set a variant coordinate, promoting a lone component into a set if needed (`axis` aliases `property`). |
| `add-variant` | `{"op":"add-variant","targetId":"<variantComponentId>","property":"<optional>"}` — clone a set member with the next unused value. |
| `repeat` | `{"op":"repeat","template":{...},"over":[...]\|"count":N,"as":"item","parentId":"<id?>","position":{"x":0,"y":0}}` — stamp copies (pass **one** of `over` or `count`). |

`repeat` substitution rules: `$i` is the 0-based index and `$<as>` (default `$item`, never `i`) reads the current entry (`$item.title`, `$item.0`); `$$` writes a literal `$`; a string holding only one token (`"$item.gap"`) keeps its native JSON type; `position: {x, y}` adds a per-entry offset; give `"id"` a unique expression such as `"card_$i"`.

Choose by scope: surgical tweaks → `patch`; section redesign → `replace`; greenfield → `compose`.

### Reuse before drawing

- A subtree that appears more than once is a `component` master plus `instance`s, not two frames. This covers buttons, cards, nav items, list rows and badges.
- The master holds structure and defaults; an instance places it with its own position and transforms (`rotate`, `scale`), carrying sparse `overrides[]` only for what differs inside the master (content, image, fill).
- Use `make-component` to promote and `instantiate` to place. Do not copy the master's JSON into a second frame.

### Where masters live

A master is a canvas element: it paints where it sits, on whichever page holds it. So give every master **one dedicated page** — put it last and name it `Components` — and place instances from there. A master hidden behind the artwork it is used in is a master nobody can find, and a master spread across pages has no single place to update.

That page is a page like any other, and it is honest about that: it appears in the page list, in the deck's page menu, and in any per-page export. What it should not do is fail a gate over boxes no instance paints. Exclude it from **grading** by name or id:

```bash
./tools/fish check design.fish.html --all-pages --geometry --skip-page Components
```

- The flag drops that page from every measurement — contrast, overlap, text-height, geometry, ink, ignored coordinates — and keeps the structural findings: a broken master breaks every instance that points at it.
- It takes a comma-separated list (`--skip-page page_kit,page_scratch`) and refuses a name that matches nothing, because "0 findings" and "the page you meant was never skipped" read the same in a summary.
- It excludes the page from `check` only. Packaging is separate: a deliverable that exports every page still exports this one, so export content pages by id (`fish export <doc> --page <id>`) when the kit page must not ship.

### Theme modes are token configuration

- If the design needs light/dark or another theme, declare `modes[]` and `activeTheme`, then put per-mode values on colour tokens: `"modes": { "dark": "#0A0A0A" }`.
- Number tokens have their own density axis (`numberModes[]`, `activeNumberMode`, and container override `numberMode`) so spacing/radii scales switch without duplicating colour modes.
- A style has no modes. Keep one style and make its paint follow a token; never duplicate a style per theme.
- `themeMode` on a container overrides its subtree. Only token- and style-bound values switch; literal colours and `page.canvas.background` do not.
- Name modes by role (`light`, `dark`, `brand`), not by their current colour.

### Sizing invariants

- Text height is measured. An omitted `height` means `sizing.height: "fit-content"`, inside a layout parent and on a free canvas alike; only an authored pixel `height` pins the box, and a pinned box shorter than its block is a finding.
- Inside a layout parent an omitted `width` is `fit-content` and wraps to the content box; on a free canvas an omitted width falls back to a character estimate, so give a wrapping run a width.
- Single-line labels, buttons, chips and nav items: `"sizing": "max-content"` (or `"max-content hug"`).
- Body copy: `"sizing": "fill hug"`.
- `line-height` numbers are unitless multipliers. `27` on 23px text means `23 × 27`; write `"27px"` for absolute pixels.
- `path.d` is raw coordinates; it does not auto-scale to `width`/`height`.
- A frame with no auto-layout cannot hug. Give it pixel sizes, or give it `display: flex | grid`.
- In `insert`, omitted `position` keeps local `x`/`y`; specify `position` only when placing in canvas world coordinates.

---

## 4. Source real assets

Never approximate a photo, portrait or logo with hand-coded paths. But the first question is not *which source* — it is whether the user already has the material, and that question belongs to the intake (`intake.md` §5), not to a search.

**Ask once, at intake.** A moodboard, brand manual, product screenshot, the real logo, licensed photography or a chosen typeface all outrank anything a stock source can return, and no search can guess them. If this run had an intake, the answer is already in `intent.md`'s material table; read it instead of asking a second time.

- **They have it** → `./tools/fish assets import` each file and place it. Their material sets the direction; do not search for a lookalike beside it. A brand manual is read first — its palette and families become tokens and `fonts[]`.
- **They named a source instead of a file** → import the URL with `--credit-name` / `--credit-url` (`assets.md` §2 “Bring a URL you already chose”). A link they chose outranks a search result, so do not look for a lookalike beside it.
- **They have none, or said “you pick”** → search the sources below, then say what you picked and why.

Never substitute stock imagery for material the user might already have without saying so, and never spend a search round before the material answer. When there was nobody to ask, place a labelled placeholder and say so at handover; the search then belongs to the polish pass.

The full source table, credentials, licences and link-vs-embed rules are in `assets.md`. The short version:

```bash
./tools/fish assets search "modern workspace" --source openverse --add-to design.fish.html --embed --to hero_rect
./tools/fish assets search "arrow-right" --source lucide --limit 3
./tools/fish assets import ./hero.jpg design.fish.html --name Hero --to hero_rect
```

- `import` is the only path for a file on this machine.
- `--embed` fetches a remote URL and inlines bytes; without it the document holds a link.
- `--to` places the fill in the same run; without it the asset is only registered.
- `--replace` swaps the image layers on the target and drops assets nothing points at any more.
- `./tools/fish check <doc> --strict-assets` fails if any asset is still a URL. An `assetId` no `doc.assets[]` entry backs is an error with or without the flag: the fill is legal and paints nothing.

---

## 5. Verify

| Tier | Command | Purpose |
| :-- | :-- | :-- |
| Structure | `./tools/fish check <doc> [--page <id> \| --all-pages]` | Schema and semantic consistency. |
| Geometry | `./tools/fish check <doc> --geometry` | Bounds, overflow, collapsed boxes. |
| Visual | `./tools/shot.sh <doc> out.png [--page <id>] [--element <id>]` | Headless render plus `out.report.json` diagnostics. |
| Glyphs | `./tools/fish check <doc> --audit` | Alignment, ink centring, empty boxes in a real browser. |

Use `--strict` to fail on warnings, `--strict-assets` before delivery, and `--all-pages` or `--page <id>` on multi-page documents so non-active pages are laid out, measured, and audited too. A components page is graded structurally only when `--skip-page <id|name>` names it (§3 "Where masters live"); the flag excludes it from every measurement while still reporting schema, reference and shape errors. A warning whose remedy is mechanical ends with `— fix: <the DSL key and value>` — apply it, or answer it with the key it names. When the document is open, `__fish.check()` gives the same verdict without re-reading the file.

**Two renderers, one protocol.** `shot.sh` and `fish export` both drive `chrome --headless`, and neither computes the window size or the crop origin — the page reports them, both callers only pass them through. Choose by what the machine has and what you need back:

- **`shot.sh`** needs bash, coreutils and a browser, and nothing else — it is the path that still works where Node is not installed. It writes `out.report.json` beside the PNG: the normalize repairs, the validate diagnostics, the coordinates auto-layout ignored (when the file states any), and the box the element actually occupies. On Windows the same tool is `powershell -File ./tools/shot.ps1`; when neither `-Element` nor `-Page` is passed it skips the report pass and writes a canvas-size stub instead, so pass `-Element` or `-Page` when you need `out.report.json`.
- **`fish export`** is already in the CLI, exports the document (or `--page <id>`) as PNG alone (`[--scale N] [--element ID]`), and answers with an exit code instead of a report. `--pages page_cover,page_feature --out-dir shots/` writes one file per page, named `<doc>--<pageId>[@Nx].png`. Every page selector here takes a page id **or its name**; the filename uses the id, because a name changes and can collide. `--exclude page_kit` leaves the components page out. Use `shot.sh` / `shot.ps1` when you need `out.report.json` beside the PNG (or where Node is not installed).

Prefer `shot.sh` when you want the diagnostics; prefer `export` when you only want the picture.

**When no browser is found.** Only `import`, `export`, `check --audit` and `assets import|embed` for raster bytes need a Chromium; nothing else does. Both entries search `FISH_BROWSER`, then Playwright's download cache, then `google-chrome` / `chromium` / `microsoft-edge` on `PATH`, then the usual macOS and Windows install paths. When that comes up empty the command stops and names `FISH_BROWSER` — point it at a binary for that one run:

```bash
FISH_BROWSER=/opt/homebrew/bin/chromium ./tools/fish check design.fish.html --audit
```

Nothing installs it and nothing needs to: it is a per-run override, not a setting the machine carries. The CLI checks that the path exists and falls back to its own search when it does not; `shot.sh` takes it as given, so a stale path there fails at launch rather than at the search. `FISH_CHROME_FLAGS` adds flags to both the same way.

---

## 6. Draft, blueprint, and polish

### 6.1 Optional blueprint gate (flagship or explicit alignment)

When starting flagship / presentation-grade work from scratch — or when the user asks to align on a plan first — present a short blueprint and get explicit approval before writing final JSON:

1. **Aesthetic direction** — a concrete posture (e.g. “precision dark instrumentation on #101010 with an amber signal”) and 5–7 colour roles.
2. **Spatial and type hierarchy** — canvas, macro layout, type scale with ≥2.5× display-to-body contrast.
3. **Asset manifest** — what the user supplies (`[by: user]`) and what comes from a source (`[by: ai]`), carried over from the material table in `intent.md`. Whatever they do not have becomes `[by: ai]` and is searched after approval. Never draw fake photos or logos.
4. **Component architecture** — the reusable masters and sets.

### 6.2 Draft-first pass (default, after intake)

Reach a viewable document quickly without spending time on browser-backed verification while placeholders are still in place:

1. **Do not ask again.** Intake (§0) is settled — it ran, or the request already answered it. §6.1 stays closed unless the work is flagship; if nobody was there to answer, `intent.md` holds the bets instead.
2. **Draft the skeleton first.** Canvas plus the key sections and labelled image placeholders (`hero image — yours or sourced?`), enough that the user can open it and react. The skeleton tests the layout; `intent.md` already fixed the goal, format and material.
3. **Create the value layer in the same pass.** Reuse existing tokens, styles, and components if present. Otherwise declare a minimal token table — 5–7 colour roles (background, surface, ink, muted ink, accent, border, scrim), a spacing scale, radii, and the type sizes actually used — and bind elements via `fills[].tokenId` / `tokenBindings`. Defer `styles[]`, `modes[]`, and `numberModes[]` until the polish pass; keep repeated cards/buttons as `component` + `instance`.
4. **State every default as an assumption.** An 8px rhythm or derived palette is a fallback, never presented as the project's final choice.
5. **One cheap gate, structure only:** run `./tools/fish check <doc>` (Node, no browser, <100ms) so the file is guaranteed to open. Leave `--geometry`, `--audit`, `shot.sh`, and `--strict` until the layout and assets are real.
6. **Hand over as a draft, with a way forward.** Say it is a first pass, name the bets no answer has closed (the ones in `intent.md`), and offer three ways to continue: point at a layer or leave a comment to change just that; name a dimension (spacing, type scale, palette, imagery, density) to steer it; or ask to polish / make it production-ready (§6.3).
7. **Iterate** through the comment/`apply` loop (§7), resolving comments with the smallest `patch`/`replace` while keeping bindings on the token table.

### 6.3 Polish and full verification

Run this pass when executing an approved blueprint, when the user asks to polish a draft, or whenever the rendered picture is the deliverable:

1. **System, assets, components** — Complete `doc.tokens[]` scales and `doc.styles[]` declaration sets (run `./tools/fish brief <doc>` to fold remaining literals into styles); embed real media (`assets.md`); ensure every repeated element is an `instance` of a `component`.
2. **Macro layout and rhythm** — Ensure cards, lists, and navbars use auto-layout on the 8px grid, with `max-content` on single-line labels and `fill hug` on body copy.
3. **Material and polish** — Execute the direction consistently: hairline strokes for separation, `cornerSmoothing: 0.6` for soft squircles (or `0` for precision), backdrop blur / liquid glass over rich backgrounds, and gradient scrims where text sits on photography.
4. **Verification and critique** — Run the full browser-backed checks together:

```bash
./tools/fish check design.fish.html --strict --geometry --audit
./tools/shot.sh design.fish.html out.png --element hero-section --scale 2
```

Add `--strict-assets` if the file must open offline. Read `out.report.json` and inspect the PNG for clipping, contrast failures, misalignment, and accidental inconsistency; fix before handing over.

---

## 7. Comments: the review loop

A `.fish.html` can carry element-bound comments in a second JSON block,
`<script id="fish-comments">`. They are the one channel by which a person marks
*this button, here* rather than describing it in chat. Never edit that block by
hand and never touch `#design-doc` while answering one: the file's identity is
the hash of the document block, so a suggestion is written to the comment block
only.

```bash
./tools/fish comments pending design.fish.html          # threads nobody has answered yet
./tools/fish comments context design.fish.html cmt_01   # target, parent, children, siblings, tokens
./tools/fish comments suggest design.fish.html cmt_01 --summary "…" --ops ops.json
./tools/fish comments reply   design.fish.html cmt_01 --text "…"
./tools/fish comments resolve design.fish.html cmt_01 --reply "…"
```

1. `pending` → one JSON row per thread: `instruction` is what the person asked
   for, `targetElementId` is the layer they pointed at.
2. `context` → that layer (laid out; or resolved derived child + `instanceTarget`) plus its parent's layout, its children, its siblings, and the document's colour/number tokens. This is the whole brief; do not read the full document for one comment.
3. `suggest` → the ops the app will show as a **diff card with before → after
   values and an Apply button**. The suggestion is not applied: the user owns
   that decision, and the app records it as one undoable step.
4. The user either accepts (thread resolves) or replies with a refinement
   (`pending` shows it again).

Rules that matter more than the sequence:

- **Reply with the same ops vocabulary as `apply`** — `{"op":"patch","targetId":"…","props":{…}}`
  — so the diff card and a direct `apply` use the same contract (`--ops` accepts an `ops.json` path or inline JSON array / `{"ops":[...]}`).
- A suggestion that changes nothing is worse than no suggestion: test the result
  of your ops on a temporary copy (`./tools/fish apply ops.json design.fish.html --out preview.fish.html && ./tools/fish check preview.fish.html`) and remove it before writing suggestions back to `#fish-comments`.
- Writing the comment block is safe while the design is open: the app reconciles
  the two sides per thread on its next save and adopts yours. Writing
  **`#design-doc`** (`fish apply`) is not — the open tab owns the document, so ask
  for it to be closed, or tell the user to reload after you write.

---

## 8. Pre-flight checklist

**Every document**

- [ ] The intent is recorded beside the document — `intent.md`, or the request itself when it already stated goal, format and material — and every assumption the artifact still rests on is named in it (or in the handover, when nobody was there to ask).
- [ ] Any element used more than once is a component master + instances, not duplicate frames — and the masters share one dedicated page that `check` was given via `--skip-page`.
- [ ] Every `instance.componentId` points at a `component`, not a `frame`.
- [ ] A wrapping text run declares a width; its height is measured (`sizing.height: "fit-content"` is what an omitted height becomes), so `height` is pinned only when the box is meant to clip.
- [ ] Mode-dependent colours live on `tokens[].modes`; no style is duplicated per theme.
- [ ] Fills, strokes, and effects are ordered bottom-first.
- [ ] Every image fill points at a real `doc.assets[]` entry.
- [ ] Repeated values are tokens; repeated declaration sets are styles.
- [ ] `fish check` reports 0 errors, and every warning's `— fix:` line was applied or answered with the key it names (plus `--geometry`, `--audit`, and `--strict-assets` per `SKILL.md` § Hard rules).

**When the project is a UI** (`category: ui`)

- [ ] Containers use auto-layout instead of hardcoded child coordinates.
- [ ] `sizing` uses a mode, not a raw number.

**When the project is graphic, editorial or a deck** (`graphic`, `deck`)

- [ ] A poster or single graphic lives inside one top-level frame (artboard dimensions, `clipsContent: true`, meaningful `name`), not as loose elements directly on the page.
- [ ] Free placement is the layout: a poster or a cover is composed, not flowed. Auto-layout only where content actually repeats.
- [ ] Deliberate layering says so — `overlap: "allowed"` on the composition root whose type crosses a shape or another text, covering everything it holds — so an accidental collision still reads as one.

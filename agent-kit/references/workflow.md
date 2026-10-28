# FISH Workflow

The DSL itself is in `dsl.md`. This file is how to move: pick a mode, get a document open, edit it, source what it needs, and verify the result.

---

## 0. Pick a working mode

| Mode | Trigger | Posture |
| :-- | :-- | :-- |
| **Fast** (default) | `/fast`, quick wireframes, conversational tweaks | Zero upfront questions. Draft the skeleton first, verify structure only, state assumptions, refine on feedback. |
| **Craft** | `/craft`, flagship deliverables, presentation-grade work | Confirm a blueprint before writing final JSON, then run the full pass pipeline and full verification. |

Both working modes use the same document and the same CLI. Fast stops at the structure check so a draft reaches the user sooner; Craft adds the blueprint gate and the browser-backed verification pass.

---

## 1. Inspect before asking

```bash
./tools/fish brief existing.fish.html    # tokens, styles (with binding counts), components, assets, fonts
./tools/fish compact existing.fish.html  # the document as compact JSON
```

Reuse what the document already carries. Ask only what neither the document nor the user's prompt can answer.

Project categories guide the DSL choices:

- `ui`: app screens, dashboards, landing pages → frames, auto-layout, 8px rhythm, components.
- `graphic`: social cards, posters, covers → free placement, declare `fonts[].src` for export.
- `brand`: logos and marks → pure vector paths.
- `dataviz`: charts, gauges, rings → sibling `ellipse` arcs.
- `icon`: 24×24 paths.
- `deck`: top-level frames as slides, with `slide.transition`.

---

## 2. Two ways in

Both produce the same editable `*.fish.html`. Pick by the job; neither is mandatory.

### HTML import — when layout fidelity is the hard part

Write a static page with CSS flex/grid and real units, then let a browser measure it:

```bash
./tools/fish import page.html --out design.fish.html --viewport 1440
./tools/fish check design.fish.html --geometry
```

Read the report before trusting it: `elementCount`, `maxDelta`, `downgraded`, `unmapped`, missing assets. `maxDelta: 0` and `unmapped: 0` means it came across whole.

- **The imported file is the source from here on.** Iterate with `apply`.
- **Never re-run `import` on a document you have edited.** It discards the edits; HTML is a seed, not a round-trip.
- A `type: "html"` element is not this. It is a view-only iframe on the canvas.

### Compact JSON — when exact control matters more

Author JSON with the shorthands in `dsl.md`, then assemble it into the shell:

```bash
./tools/fish compose design.json templates/blank.fish.html --out design.fish.html --compact
```

Or pipe it:

```bash
./tools/fish compose - templates/blank.fish.html --out design.fish.html --compact <<'EOF'
{ "version": "0.1", "canvas": { "width": 1440, "height": 900 }, "elements": [] }
EOF
```

---

## 3. Edit with macro-ops

The artifact itself carries no op runtime; the agent kit's CLI runs every op in this table against the `#design-doc` block and writes it back.

```bash
./tools/fish apply ops.json design.fish.html --compact
```

| Op | Semantics |
| :-- | :-- |
| `patch` | Modify properties on an element. |
| `replace` | Replace a subtree, preserving its id. |
| `insert` | Insert an element or artboard under a parent. |
| `remove` | Delete elements by id. |
| `intent` | Wrap layers in auto-layout (`wrap-in-stack` / `wrap-in-grid`). |
| `boolean` | Union / subtract / intersect / exclude shapes. |
| `make-component` | Promote a frame to a component master. |
| `instantiate` | Place an instance of a master. |
| `reset-instance` | Drop instance overrides. |
| `detach-instance` | Expand an instance into a frame. |
| `repeat` | Expand a template over data into concrete elements. |

Choose by scope: surgical tweaks → `patch`; section redesign → `replace`; greenfield → `compose`.

### Reuse before drawing

- A subtree that appears more than once is a `component` master plus `instance`s, not two frames. This covers buttons, cards, nav items, list rows and badges.
- The master holds structure and defaults; each instance carries only sparse overrides for what differs (content, image, size).
- Use `make-component` to promote and `instantiate` to place. Do not copy the master's JSON into a second frame.

### Theme modes are token configuration

- If the design needs light/dark or another theme, declare `modes[]` and `activeTheme`, then put per-mode values on colour tokens: `"modes": { "dark": "#0A0A0A" }`.
- A style has no modes. Keep one style and make its paint follow a token; never duplicate a style per theme.
- `themeMode` on a container overrides its subtree. Only token- and style-bound values switch; literal colours and `page.canvas.background` do not.
- Name modes by role (`light`, `dark`, `brand`), not by their current colour.

### Sizing invariants

- Text height is measured. Inside a layout parent, an omitted width is `fit-content` and wraps to the content box; outside one it falls back to character estimation.
- Single-line labels, buttons, chips and nav items: `"sizing": "max-content"` (or `"max-content hug"`).
- Body copy: `"sizing": "fill hug"`.
- `line-height` numbers are unitless multipliers. `27` on 23px text means `23 × 27`; write `"27px"` for absolute pixels.
- `path.d` is raw coordinates; it does not auto-scale to `width`/`height`.
- A frame with no auto-layout cannot hug. Give it pixel sizes, or give it `display: flex | grid`.
- In `insert`, omitted `position` keeps local `x`/`y`; specify `position` only when placing in canvas world coordinates.

---

## 4. Source real assets

Never approximate a photo, portrait or logo with hand-coded paths. The full source table, credentials, licences and link-vs-embed rules are in `assets.md`. The short version:

```bash
./tools/fish assets search "modern workspace" --source openverse --add-to design.fish.html --embed --to hero_rect
./tools/fish assets search "arrow-right" --source lucide --limit 3
./tools/fish assets import ./hero.jpg design.fish.html --name Hero --to hero_rect
```

- `import` is the only path for a file on this machine.
- `--embed` fetches a remote URL and inlines bytes; without it the document holds a link.
- `--to` places the fill in the same run; without it the asset is only registered.
- `--replace` swaps the image layers on the target and drops assets nothing points at any more.
- `./tools/fish check <doc> --strict-assets` fails if any asset is still a URL.

---

## 5. Verify

| Tier | Command | Purpose |
| :-- | :-- | :-- |
| Structure | `./tools/fish check <doc>` | Schema and semantic consistency. |
| Geometry | `./tools/fish check <doc> --geometry` | Bounds, overflow, collapsed boxes. |
| Visual | `./tools/shot.sh <doc> out.png [--element <id>]` | Headless render plus `out.report.json` diagnostics. |
| Glyphs | `./tools/fish check <doc> --audit` | Alignment, ink centring, empty boxes in a real browser. |

Use `--strict` to fail on warnings and `--strict-assets` before delivery. When the document is open, `__fish.check()` gives the same verdict without re-reading the file.

**Two renderers, one protocol.** `shot.sh` and `fish export` both drive `chrome --headless`, and neither computes the window size or the crop origin — the page reports them, both callers only pass them through. Choose by what the machine has and what you need back:

- **`shot.sh`** needs bash, coreutils and a browser, and nothing else — it is the path that still works where Node is not installed. It writes `out.report.json` beside the PNG: the normalize repairs, the validate diagnostics, and the box the element actually occupies. On Windows the same tool is `powershell -File ./tools/shot.ps1`; without `-Element` it skips the report pass and writes a canvas-size stub instead, so treat its report as element-scoped.
- **`fish export`** is already in the CLI, writes the PNG alone, and answers with an exit code instead of a report.

Prefer `shot.sh` when you want the diagnostics; prefer `export` when you only want the picture.

**When no browser is found.** Only `import`, `export`, `check --audit` and `assets import|embed` for raster bytes need a Chromium; nothing else does. Both entries search `FISH_BROWSER`, then Playwright's download cache, then `google-chrome` / `chromium` / `microsoft-edge` on `PATH`, then the usual macOS and Windows install paths. When that comes up empty the command stops and names `FISH_BROWSER` — point it at a binary for that one run:

```bash
FISH_BROWSER=/opt/homebrew/bin/chromium ./tools/fish check design.fish.html --audit
```

Nothing installs it and nothing needs to: it is a per-run override, not a setting the machine carries. The CLI checks that the path exists and falls back to its own search when it does not; `shot.sh` takes it as given, so a stale path there fails at launch rather than at the search. `FISH_CHROME_FLAGS` adds flags to both the same way.

---

## 6. Fast mode

Fast is draft-first: reach a viewable document quickly, then refine against feedback. It deliberately spends no time on browser-backed verification until the draft is accepted or the picture is the deliverable.

1. **Zero upfront questions.** Skip the blueprint gate.
2. **Draft the skeleton first.** Canvas plus the key sections and placeholders, enough that the user can open it and react. Do not polish the whole document before the direction is confirmed.
3. **Create the value layer in the same pass.** Reuse the document's tokens, styles and components if it has them. If it has no token table, declare a minimal one as you author the skeleton — 5–7 colour roles (background, surface, ink, muted ink, accent, border, scrim), a spacing scale, radii, and the type sizes you actually use — and reference it from the elements (`fills[].tokenId`, `tokenBindings`). This is what turns a later “change the palette / tighten the spacing” into one edit instead of a per-element rebind. Defer `styles[]`, `modes[]` and `numberModes[]` to the system pass; do not build them speculatively. A value that repeats or is global becomes a token; a one-off decorative value stays a literal.
4. Still make repeated cards/buttons components rather than copies.
5. State every default as an assumption. An 8px rhythm is a safe fallback; palette values are derived from the canvas background or declared as assumptions, never presented as the project's colours.
6. **One cheap gate, structure only:** `./tools/fish check <doc>` (Node, no browser, well under 100ms) so the file is guaranteed to open. Do **not** run `--geometry`, `--audit`, `shot.sh` or `--strict` in this pass — the browser-backed tiers cost seconds and belong to the full pass or an explicit request.
7. **Hand over as a draft, with a way forward.** In one short block, say it is a first pass, not a final, list the assumptions, and give three ways to continue: point at a layer or leave a comment to change just that; name a dimension (spacing, type scale, palette, imagery, density) to steer it; say “polish it” / “make it production-ready” to trigger the full pass in §7. Do not make the user learn “Fast” / “Craft”; map their intent onto the mode.
8. Iterate through the comment/`apply` loop as the user replies. Answer a comment with the smallest `patch`/`replace` that resolves it, and keep binding new work to the token table instead of duplicating a literal it already names.
9. When the user asks for the full pass, or the picture is the deliverable, promote the draft with the §5 tiers: `--geometry`, then `--audit` and `shot.sh` when pixels matter, `--strict-assets` for offline.

---

## 7. Craft mode

Craft adds one gate and one deeper pass; it does not replace the workflow above.

### 7.1 Blueprint gate

Before writing final JSON, present a blueprint and get explicit approval:

1. **Aesthetic direction** — a concrete posture (e.g. “precision dark instrumentation on #101010 with an amber signal”) and 5–7 colour roles.
2. **Spatial and type hierarchy** — canvas, macro layout, type scale with ≥2.5× display-to-body contrast.
3. **Asset manifest** — what the user supplies (`[by: user]`) and what comes from a source (`[by: ai]`). Never draw fake photos or logos.
4. **Component architecture** — the reusable masters and sets.


### 7.2 Pass 1 — system, assets, components

- Author colour and number scales in `doc.tokens[]`; declaration sets in `doc.styles[]`.
- Run `./tools/fish brief <doc>` again and fold literals into styles where the report shows gaps.
- Embed authentic media (see `assets.md`) and build reusable masters as `type: "component"`. Every element that repeats in the final layout must be an instance of a master.

### 7.3 Pass 2 — macro layout and rhythm

- Wrap cards, lists and navbars in auto-layout.
- Apply the 8px grid to gaps and padding.
- Set `max-content` on single-line labels and `fill hug` on body copy.

### 7.4 Pass 3 — material and polish

Execute the approved blueprint rather than a recipe. Use the levers the direction calls for:

- hairline strokes for separation;
- `cornerSmoothing: 0.6` for soft squircles, `0` for precision;
- backdrop blur or liquid glass over rich backgrounds;
- gradient scrims where text sits on photography;
- consistent edge treatment across the whole document.

### 7.5 Pass 4 — verification and critique

```bash
./tools/fish check design.fish.html --strict --geometry
./tools/fish check design.fish.html --audit
./tools/shot.sh design.fish.html out.png --element hero-section --scale 2
```

Read `out.report.json` and inspect the PNG for clipping, contrast failures, misalignment and accidental inconsistency. Fix before handing over.

---

## 8. Comments: the review loop

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
2. `context` → that layer plus its parent's layout, its children, its siblings
   and the document's colour tokens. This is the whole brief; do not read the
   full document for one comment.
3. `suggest` → the ops the app will show as a **diff card with before → after
   values and an Apply button**. The suggestion is not applied: the user owns
   that decision, and the app records it as one undoable step.
4. The user either accepts (thread resolves) or replies with a refinement
   (`pending` shows it again).

Rules that matter more than the sequence:

- **Reply with the same ops vocabulary as `apply`** — `{"op":"patch","id":"…","value":{…}}`
  — so the diff card and a direct `apply` cannot disagree.
- A suggestion that changes nothing is worse than no suggestion: run
  `./tools/fish check` on the result of your ops before writing them back.
- Writing the comment block is safe while the design is open: the app reconciles
  the two sides per thread on its next save and adopts yours. Writing
  **`#design-doc`** (`fish apply`) is not — the open tab owns the document, so ask
  for it to be closed, or tell the user to reload after you write.

---

## 9. Pre-flight checklist

- [ ] Containers use auto-layout instead of hardcoded child coordinates.
- [ ] Wrapping text outside a layout parent declares a width mode.
- [ ] `sizing` uses a mode, not a raw number.
- [ ] Any element used more than once is a component master + instances, not duplicate frames.
- [ ] Every `instance.componentId` points at a `component`, not a `frame`.
- [ ] Mode-dependent colours live on `tokens[].modes`; no style is duplicated per theme.
- [ ] Fills and strokes are ordered bottom-first.
- [ ] Every image fill points at a real `doc.assets[]` entry.
- [ ] Real photos and icons come from the asset sources, not hand-drawn paths.
- [ ] Repeated values are tokens; repeated declaration sets are styles.
- [ ] `fish check` reports 0 errors; before delivery (Craft), `--geometry` and, when relevant, `--audit` were read.
- [ ] The file opens offline if that was promised (`--strict-assets`).

# Mobile — View Mode

**Status:** the viewer ships (`src/ui/viewer/`). Editing on a phone is out of scope
**by decision, not by omission** — `?view=editor` is the honest way to ask for it.

A phone opens a document to *read* it: check a layout, show a client, follow a
link, see whether page 3 landed. Everything below follows from that one sentence.

---

## 1. The rules

These are the standing rules. A new mobile surface that breaks one of them is a
defect, not a preference.

### R1 — One stage, three shells. The shell is chosen once per load.

| Shell | Entered by | Adds |
|---|---|---|
| `EditorShell` | default | Layer panel, inspector, dock, selection, every editing overlay |
| `ViewerShell` | `pointer: coarse` **and** width ≤ 820, or `?view=viewer`, or the file is read-only | Touch camera, page menu, zoom pill |
| `CanvasOnlyView` | `?view=canvas` | Nothing — the artwork at 1:1, for screenshots and embeds |

All three mount the same `DocumentStage`; none builds its own `<defs>`. The
choice is read once at load and never re-evaluated on resize: the two shells
mount different hook trees, so a runtime swap would change how many hooks run in
one component instance. A rotation is not a mode change.

### R2 — Two conditions, or the editor appears broken.

A narrow window on a mouse-driven desktop keeps the editor. A wide touch device
(a tablet in landscape) keeps the editor. Only **coarse pointer + ≤ 820px** enters
the reader — width alone sends a desktop user who dragged their window narrow
into a reading surface with no way back that they can see.

`?view=editor` is the escape hatch, and it is a reload.

A file that says it is read-only is the third entrance to the reader, and the
only one no device rule can veto — see [`READONLY.md`](READONLY.md). It is not a
fourth shell: same reader, a different reason for being in it.

### R3 — Touch decides before the first move; bind accordingly.

`touch-action: none` on the element the gesture is bound to, and Pointer Events
with `setPointerCapture`. Mouse events and post-hoc `preventDefault` lose the
gesture before dispatch.

A board that pans is a board that says so: the stage shows an open hand at rest
and a closed one while a pointer is down. On a device with a pointer this is the
only place the pan is announced — the chrome is three pills, and a gesture nobody
can discover is not an interaction.

### R4 — The gesture grammar is five items and no more.

| Gesture | Meaning |
|---|---|
| One finger drag | Pan |
| Two finger pinch | Zoom about the midpoint |
| Double tap | 100% at the tap, or back to fit |
| Tap | Follow a link; otherwise nothing |
| Wheel / ctrl+wheel | Pan / zoom (desktop parity, not a mobile feature) |

A gesture that ever held two pointers never becomes a tap. Slop 8px / 350ms for a
tap, 32px / 320ms for its second half. No long-press, no swipe-to-navigate, no
three-finger anything: **a gesture nobody can discover is not an interaction.**

### R5 — Chrome floats, never docks, never hides.

Three pills over a full-bleed board: document name and page switcher (top left),
**Desktop mode** (top right), zoom −/%/+/⛶/▶ (bottom centre). Nothing else.

- A 44px strip top and bottom costs 10% of the screen, and the document is the content.
- No auto-hide: with no pointer to hover, a control that disappears is a control
  the user must rediscover — and the tap that would bring it back is the same tap
  that has to mean "follow this link".
- **Page switching is a menu, not pagination.** Pages are a list, not a sequence:
  with nine pages nobody pages through them, and two arrow buttons spend 112px of
  a 390px screen on an assumption.
- Every target is ≥ 44px. The desktop menu row is 26px and must not be reused here.
- **The canvas is the surface.** The reader paints the document's own canvas
  colour across the whole view, exactly as the editor's canvas area does: a light
  artboard on the workbench's black reads as "my background did not carry over".
  No outline around the page — the editor draws none, and a line around the
  artboard is a mark the document never made. A paint the reader cannot draw (a
  gradient, a bitmap) leaves `panel` showing rather than tinting the screen with a
  value the document never asked for.

### R6 — The camera is pure, and it is tethered.

`ui/viewer/viewer-camera.ts` holds every rule as a function with no DOM in it:

- A fit **never magnifies** past 1:1, and leaves 14px of breathing room.
- A pinch anchors the world point under its midpoint — the board must not slide
  while the fingers are still.
- A pan may not carry the board off screen: 56px of it always stays visible. A
  reader has no scrollbars, so a fling into empty space looks like an empty file.
- Zoom is clamped to the editor's range (2%–6400%), so both shells agree.

Refit happens on exactly four events: first measure, page change, orientation
change, board change. **Not on every resize** — on iOS the address bar collapsing
is a resize the user never asked for, and refitting there throws away the
magnified view they were reading.

### R7 — The viewer never writes the document.

- Page switching is local state. It must **not** go through `usePageManagement`,
  which persists a viewport into the page's metadata and marks the file dirty —
  "just looking" must not become an autosave prompt.
- A page that was never laid out is reflowed into a memo (`relayoutDocumentTree`),
  not into the document.
- After a viewing session the file on disk is byte-identical. That is the test.

### R8 — Mobile does not get the editor's surface area.

No selection, no hover, no context menu, no inspector, no layer tree, no tokens
panel, no comments, no plugins. Each would need its own touch design; until it
has one, it stays off the phone. `Desktop mode` is the only path to them, and the
label says exactly what it costs.

### R9 — Every future mobile surface states its shell and its gestures.

Before building one, answer: which of the three shells hosts it, what does it do
with one finger, with two, and what happens when it is not there. A surface that
cannot answer all three is a desktop surface.

### R10 — Presenting is the reader's second mode, and it fills the screen.

- Entered from the play button in the zoom pill, and it opens **in the shell's own
  box** — playing never takes the system chrome away by itself. Full screen is the
  deck's own button, the same deliberate second press it is on the desktop. Where
  the platform has no element fullscreen (iPhone Safari), that button is not
  rendered rather than rendered dead.
- The deck plays **the page being read**, not `activePageId` — the reader
  switches pages without committing one. `presentationFrames(doc, page)` takes the
  override for exactly this, and `PresentOverlay` takes it for the backdrop.
- The screen splits, for every pointer: **left 30% is back, the rest is forward**.
  A mouse used to keep "any click advances"; that made the left third of a slide
  a region where a click silently moved the deck the wrong way. A link still wins
  over both zones — a mis-aimed tap that navigated away is worse than one that
  went to the previous slide. The keys (arrows, Space, Home/End, Escape) are bound
  **in this shell**, because the shortcut layer that owns them in the editor is
  not fed by it.
- HUD controls become 44px under a finger; 24px is a mouse metric.
- The deck's menu is the desktop's menu — same rows, so `Use canvas background`
  is offered here too. It cannot write the document (R7), so the reader answers
  it per page in session state: the deck repaints at once, the file stays
  byte-identical, and a reload forgets the answer.

---

## 2. How it is built today

```
src/ui/viewer/
  viewer-mode.ts       resolveViewMode / editorHref / currentViewMode   (pure)
  viewer-camera.ts     fit / zoomAt / pan / clamp / viewportBox         (pure)
  useViewerGestures.ts pointer map, pinch, tap, double tap, wheel
  ViewerStage.tsx      <div touch-action:none> + svg + DocumentStage
  ViewerChrome.tsx     three pills, page menu
  ViewerShell.tsx      page index, camera state, refit triggers
```

- `main.tsx` picks the shell before any hook exists and mounts only that root
  (`ViewerRoot` / `CanvasOnlyRoot` / `EditorRoot`), so the reader never builds
  the editor's hook tree at all.
- `DocumentStage` is mounted exactly as `PresentOverlay` mounts it, including the
  backdrop rule (`stage-transform-mode.ts`): a page with both a backdrop blur and
  a blend mode takes the `<g>`-attribute transform instead of a CSS transform.
- `viewportBox` comes from the camera, so culling works the same as the editor's.
- `viewport-fit=cover` in `index.html` plus `env(safe-area-inset-*)` on both pills.

## 3. Verification

- `tests/viewer-camera.test.ts` — fit geometry, pinch anchor, tether, culling box.
- `tests/viewer-mode.test.ts` — every `?view=` value, the device rule, the href.
- Touch behaviour changes need a 390×844 `hasTouch` probe covering: fit on load,
  drag, a pinch that must land on exactly 2.00×, double tap both ways, the page
  menu opening and closing on an outside tap, `Desktop mode` pointing at
  `?view=editor`, and a deck where tap-right advances and tap-left goes back.
- Trap: `?view=` is read from the **built** shell. After touching `src/`, run the
  full `npm run build` — a bare `vite build` leaves `dist/` without the runtime
  blocks and turns `version-consistency` red for reasons unrelated to the change.

## 4. Open questions

1. **Landscape.** The pills have not been measured against a landscape notch.
2. **Deep links.** `?view=viewer&page=<id>` so a review link opens on one page.
3. **Comments.** Review is the one editing-adjacent thing a phone is genuinely
   good at, and pins currently exist only in the editor. Needs a tap target design.
4. **Presenting a landscape deck on a portrait phone.** The slide letterboxes to
   about 19% of a 2100px board. Rotating works, but the deck does not ask for
   landscape and iOS cannot lock it outside a native app.
5. **Presenter notes.** Nothing reads `slide.notes` on a phone, where they would
   actually be useful.

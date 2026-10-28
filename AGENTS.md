# AGENTS.md

Guidelines and operational constraints for AI agents developing FISH.

---

## 0. Project Documentation Index

All core architectural and product specifications live under `docs/`, with one exception: the agent-facing kit is its own tree.

- [**`DESIGN.md`**](docs/DESIGN.md) — **The single source of truth for how the workbench LOOKS**: colour, type, radii, depth, motion, the label tiers, the menu. Tokens in front matter, rationale in the body. Read it before writing or changing any UI. §3 below is its enforcement, not a substitute for it.
- [**`docs/ARCHITECTURE.md`**](docs/ARCHITECTURE.md) — Single-file self-executing container architecture, data bridge, DSL-to-SVG rendering pipeline, and design tokens.
- [**`docs/PLUGINS.md`**](docs/PLUGINS.md) — **Plugin architecture & development guide**: Micro-kernel design, dependency injection contracts, Design System integration, and building modular plugins.
- [**`agent-kit/`**](agent-kit/) — **The agent-facing kit, as hand-written source**: `SKILL.md` (entry point) plus `references/` (`workflow.md`, `dsl.md`, `assets.md`). It mirrors `dist/fish-agent-kit/`, which `npm run build` assembles from it. Not a summary of the engine: `tests/version-consistency.test.ts` grades the document dialect against `references/dsl.md`, so a dialect change that skips that file fails the build.

---

## 1. Git Operation Policy (Mandatory Constraint)
- **Strictly prohibit autonomous Git commits (`git commit` / `git push`)**.
- Git commits must only be performed when the user explicitly requests a commit in the active conversation (e.g. "please commit these changes").

---

## 2. Minimalist Code Comments (Code is Agent-to-Agent)

Code here is written by agents and read by agents. Names and types already say *what* the code does. A comment earns its place only by carrying a *why* that the next agent cannot rebuild from the code itself. (workarounds, temporory hacks, external constraints, non-local invariants, etc. )

---

## 3. UI Design — `DESIGN.md` Is the Only Standard (Mandatory)

**Read `DESIGN.md` before you write or change any UI.** It is the authority for colour, type, radii, depth, motion, the label tiers, the menu, and which text may speak the sans stack. It is not the authority for behaviour: a gesture, a mixed-state field or a canvas affordance's condition is defined by the implementation and the test that grades it. Where a file and `DESIGN.md` disagree, `DESIGN.md` wins.

1. **New UI conforms, no exceptions.** Every token comes from `tailwind.config.js`, every size/weight from the theme's scale, every user-facing string through `t("scope.key")` (§4). Never an ad-hoc hex utility (`bg-[#181818]`), a stock palette step (`text-gray-400`), a stock Tailwind size (`text-xs`), a stock shadow (`shadow-lg`), a bare `rounded`, or an arbitrary radius. `tests/ui-conventions.test.ts` enforces all of these — if it is red, the UI is wrong, not the test.
2. **Do not invent a value that already has a name.** If the value exists as a token or a shared class (`SUB_LABEL_CLASS`, `MENU_ITEM_CLASS`, `PAINT_ROW_CLASS`, `ACTION_BUTTON_CLASS`, `DARK_RING_CLASS`), use it. A one-off spelling of the same object is the exact defect those modules exist to prevent.
3. **Surface violations you find; never quietly follow one.** Existing UI that breaks `DESIGN.md` is a bug to report — name the file, the line, the rule, and the measured consequence (contrast ratio, px mismatch, two accents where there should be one). Reporting it is required even when it is outside the change you were asked to make; fixing it is the user's call.
4. **The spec is changed by agreement, never by precedent.** When the code and `DESIGN.md` disagree, do not resolve it by editing the rule to match the code, and do not rule against a user's direct observation on the strength of an abstract principle — measured behaviour wins, and the document is corrected afterwards. Say which part you are changing and why, then change it in the same change.

---

## 4. Internationalization (i18n)
- The application currently operates in English, but the codebase must be strictly decoupled for multi-language support.
- **Never hardcode user-facing strings directly in components.**
- All user-facing labels, tooltips, and toasts must be routed through `t("scope.key")` in `src/i18n/`.

---

## 5. Critical Pitfalls & Hard Constraints Capture
- **Only document genuinely complex, hard-to-debug, or recurring pitfalls** in the appropriate module under `docs/lessons/` (and list in `docs/LESSONS_LEARNED.md`). Do not record standard bugs, routine refactors, or transient edge cases.
- Entries must be **strictly concise (under 5 lines)**, written in English: State only the symptom, root cause, and the hard constraint/rule. Do not write retrospective essays or migration treatises.

---

## 5.1 Testing Rigs (Derive, Don't Restate; A Rig Nothing Runs Is Not a Rig)
- **A rig must read the list it grades, never copy it.** A hand-transcribed list cannot report a gap in the set it was given: add a member to a closed union and every copy still passes. Import the union (`src/core/dsl/schema-enums.ts`) and grade against it. `tests/type-coverage.test.ts` is the pattern; `tests/version-consistency.test.ts` is the same idea applied to the schema.
- **Registering a new surface in `tests/type-coverage.test.ts` is a deliberate claim** that a union member with no case there is a defect, not a choice. Do not add a file that legitimately handles a subset.
- **Every script under `scripts/` must be reachable from `package.json` or `vite.config.ts`,** directly or by being named in a script that is. `tests/rig-registration.test.ts` enforces it: give the script an npm script, have a registered script call it, or delete it. Never add it to an exception list.

---

## 6. Privacy & Path Hygiene
- **Never include personal directory paths, usernames, or private environment information** in any documentation, commit messages, or source code.
- Always use repo-relative paths (e.g. `src/main.tsx`, `dist/fish-agent-kit/templates/blank.fish.html`, `docs/ARCHITECTURE.md`).

---

## 7. Keyboard & IME Handling
- All text inputs (renaming, search, prompts, content fields) and global key listeners must guard against IME composition:
  ```ts
  if (e.isComposing || (e as any).keyCode === 229) return;
  ```
- Global shortcuts must ignore events originating from editable inputs (`input`, `textarea`, `isContentEditable`).

---

## 8. Modularization & File Size Discipline
- Proactively modularize and componentize: extract cohesive units (components, hooks, utilities, types) instead of growing a single file.
- At **500 lines**, stop and evaluate whether the file is worth splitting — split when a coherent seam exists, even if the code is not yet broken.
- **Hard ceiling: 1000 lines.** A source file exceeding it must be split as part of the current change, not deferred.
- Exempt from this rule: test scripts/fixtures, temporary files, i18n resource files, generated code, pure data/asset tables, and **type-declaration modules** — a vocabulary that lives in one place (`src/core/dsl/types.ts`) is worth more than a line count, and splitting it makes every element interface import the union it belongs to from somewhere else. A declaration module carrying runtime code still has to give that code up.
- **Keep the shipped file small.** The product is one HTML file a designer opens from their desktop: every kilobyte is downloaded, parsed and held in memory before anything appears on screen, and it travels inside every saved design. Write the leaner construction, and add a dependency only when it earns its bytes. There is deliberately no numeric cap — a threshold only reports that it was crossed — and every build prints the size, so a drift is visible rather than enforced.

---

## 9. Version Numbers Are Manual
- **An agent never changes a version number.** Both axes are human-controlled:
  - the **app version** — `package.json` `version`, stamped into the shell and copied into recovery snapshots as `appVersion`. It moves when a release is cut, by hand.
  - the **document dialect** — `src/core/dsl/versions.json`, read as `LATEST_DOCUMENT_VERSION`. Pre-release there is one dialect (`0.1`) and no migration scaffold: a change in what stored values *mean* edits that dialect in place and switches every writer in the same change. See `docs/ARCHITECTURE.md` §1.2.
- The dialect has exactly one source; everything else derives from it or is asserted by `tests/version-consistency.test.ts`. A new writer — a script that emits documents, a template, a fixture claiming to be current — must be added to that test in the same change.
- `agent-kit/references/dsl.md` is the one hand-written prose copy of the dialect, because external authors read it without running the app. `tests/version-consistency.test.ts` reads that file (`DSL_DOC`) and fails when it drifts; there is no second copy to update.

---

## 10. Canvas SVG DOM Hygiene & Zoom Performance
- **Zero Bare `<g>` Wrappers**: Never emit bare or single-child `<g>` tags without styling, filter, mask, or clipping roles. Use React `<>` (`Fragment`) to group children, and attach `transform` directly to SVG shapes (`<rect>`, `<path>`).
- **Hoist Zoom-Dependent Attributes**: Dynamic attributes like `strokeWidth={1 / zoom}` must be hoisted to a single parent `<g>` or CSS `[data-chrome-counter]`, never repeated across individual leaf elements.
- **Bound Multi-Selection Chrome**: Interactive outline rendering must be bounded (e.g. `MAX_INDIVIDUAL_SELECTION_OUTLINES`) to prevent DOM explosion when hundreds of elements are selected.


